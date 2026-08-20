// The self-update system: checking a branch's latest built sha, resolving
// full-vs-patch update packages, and authorizing a specific tester to
// download one. Reads R2 objects the queue/CI system (queue.ts, via
// base-build.yml) writes to `base/<branch>/...` - if you remove the queue
// system, you'll need some other way to populate those objects for updates
// to keep working, or just don't wire scr_auth.gml's update-check calls in.
import type { Env, Session } from "./types";
import { json, randState, page, updateTtl, logEvent } from "./util";
import { authorizeUrl, isMember, isDev, alertUpdateFailed } from "./discord";
import { isOpenPrBranch, openPrBranches } from "./github";
import { getBuild, tokenAuthorizedFor, verifyDeviceToken, type VerifyFile } from "./builds";

export function testableBranch(env: Env): string {
  return env.TESTABLE_BRANCH || "main";
}

export function includePrBranches(env: Env): boolean {
  return (env.INCLUDE_PR_BRANCHES || "").toLowerCase() === "true";
}

export const availableBranches = (env: Env) =>
  new Set((env.AVAILABLE_BRANCHES || "").split(",").map((s) => s.trim()).filter(Boolean));

export async function resolveTrackingBranch(env: Env, branch: string): Promise<string> {
  const testable = testableBranch(env);
  if (branch === testable) return testable;

  const legitimate = availableBranches(env).has(branch)
    || (includePrBranches(env) && await isOpenPrBranch(env, branch));
  if (!legitimate) return testable;

  const hasBase = await env.BUILDS_R2.head(`base/${branch}/latest.json`);
  if (!hasBase) return testable;

  return branch;
}

export async function computeBranchList(env: Env): Promise<{ testable: string; branches: string[] }> {
  const testable = testableBranch(env);
  let branches = [testable, ...availableBranches(env)];
  if (includePrBranches(env)) {
    branches = branches.concat(await openPrBranches(env));
  }
  branches = branches.filter((b, i, arr) => arr.indexOf(b) === i);
  return { testable, branches };
}

export async function listBranches(env: Env): Promise<Response> {
  return json(await computeBranchList(env));
}

type UpdatePackageResult =
  | { ok: true; upToDate: true }
  | { ok: true; upToDate: false; key: string; mode: "patch" | "full"; targetSha: string; packageSha256?: string; verify?: VerifyFile[] }
  | { ok: false; reason: string };

const MAX_VERIFY_FILES = 64;

async function loadPatchManifest(env: Env, branch: string, currentSha: string, targetSha: string): Promise<VerifyFile[] | undefined> {
  const manifestObj = await env.BUILDS_R2.get(`base/${branch}/patches/${currentSha}-${targetSha}.manifest.json`);
  if (!manifestObj) return undefined;
  try {
    const parsed = (await manifestObj.json()) as { files?: VerifyFile[] };
    return Array.isArray(parsed.files) ? parsed.files : undefined;
  } catch {
    return undefined;
  }
}

async function resolveUpdatePackage(env: Env, branch: string, currentSha: string): Promise<UpdatePackageResult> {
  const latestObj = await env.BUILDS_R2.get(`base/${branch}/latest.json`);
  if (!latestObj) return { ok: false, reason: `no base build for branch '${branch}'` };
  const latest = (await latestObj.json()) as { sha: string };
  if (latest.sha === currentSha) return { ok: true, upToDate: true };

  const patchKey = `base/${branch}/patches/${currentSha}-${latest.sha}.hdiff`;
  const patchHead = await env.BUILDS_R2.head(patchKey);
  if (patchHead) {
    const verify = await loadPatchManifest(env, branch, currentSha, latest.sha);
    if (!verify || verify.length <= MAX_VERIFY_FILES) {
      return {
        ok: true, upToDate: false, key: patchKey, mode: "patch", targetSha: latest.sha,
        packageSha256: patchHead.customMetadata?.sha256, verify,
      };
    }
    console.warn(`patch ${patchKey} touches ${verify.length} files (> ${MAX_VERIFY_FILES}) - can't safely verify client-side, falling back to full`);
  }

  const fullKey = `base/${branch}/${latest.sha}.zip`;
  const fullHead = await env.BUILDS_R2.head(fullKey);
  if (fullHead) {
    return {
      ok: true, upToDate: false, key: fullKey, mode: "full", targetSha: latest.sha,
      packageSha256: fullHead.customMetadata?.sha256,
    };
  }
  return { ok: false, reason: `no full or patch base available (${currentSha} -> ${latest.sha})` };
}

export async function createUpdateSession(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { build_id?: string; branch?: string; current_sha?: string };
  const buildId = (body.build_id || "").trim();
  const branch = (body.branch || "").trim();
  const currentSha = (body.current_sha || "").trim();
  if (!buildId || !(await getBuild(env, buildId))) return json({ error: "unknown build" }, 404);
  if (!branch || !currentSha) return json({ error: "branch and current_sha required" }, 400);

  const state = randState();
  const sess: Session = {
    build_id: buildId, created: Date.now(), status: "pending",
    kind: "update", update_branch: branch, update_current_sha: currentSha,
  };
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: updateTtl(env) });

  return json({
    state,
    authorize_url: authorizeUrl(env, state),
    poll_url: `${env.PUBLIC_BASE_URL}/api/result?state=${state}`,
  });
}

export async function createUpdateSessionFast(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    build_id?: string; branch?: string; current_sha?: string; device_token?: string;
  };
  const buildId = (body.build_id || "").trim();
  const branch = (body.branch || "").trim();
  const currentSha = (body.current_sha || "").trim();
  if (!buildId || !branch || !currentSha) return json({ cached: false });

  const build = await getBuild(env, buildId);
  if (!build) return json({ cached: false });

  const decoded = body.device_token ? await verifyDeviceToken(env, body.device_token) : null;
  if (!(await tokenAuthorizedFor(env, decoded, build))) return json({ cached: false });

  const ip = req.headers.get("cf-connecting-ip") || undefined;

  const trackedBranch = await resolveTrackingBranch(env, branch);
  const resolved = await resolveUpdatePackage(env, trackedBranch, currentSha);
  if (!resolved.ok) return json({ cached: false });
  if (resolved.upToDate) {
    await logEvent(env, {
      build_id: buildId, build_tester_id: build.tester_id, build_label: build.label,
      verified_tester_id: decoded!.tester_id, cached: true, ip, kind: "update", verdict: "up_to_date",
    });
    return json({ cached: true, up_to_date: true });
  }

  const state = randState();
  const sess: Session = {
    build_id: buildId, created: Date.now(), status: "done", authorized: true, user_id: build.tester_id,
    kind: "update", update_branch: branch, update_current_sha: currentSha,
    update_key: resolved.key, update_mode: resolved.mode, update_target_sha: resolved.targetSha,
    update_package_sha256: resolved.packageSha256, update_verify: resolved.verify,
  };
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: updateTtl(env) });
  await logEvent(env, {
    build_id: buildId, build_tester_id: build.tester_id, build_label: build.label,
    verified_tester_id: decoded!.tester_id, cached: true, ip, kind: "update", verdict: "allow",
    update_key: resolved.key, update_mode: resolved.mode,
  });

  return json({
    cached: true, up_to_date: false,
    poll_url: `${env.PUBLIC_BASE_URL}/api/result?state=${state}`,
  });
}

export async function updateAuth(env: Env, state: string, sess: Session, user: { id: string; username?: string }, ctx: ExecutionContext): Promise<Response> {
  const branch = await resolveTrackingBranch(env, sess.update_branch || "");
  const currentSha = sess.update_current_sha || "";
  const build = await getBuild(env, sess.build_id);
  if (!build) {
    ctx.waitUntil(alertUpdateFailed(env, sess.build_id, user, "unknown build"));
    return page("Unknown build.", false, 404);
  }
  const member = await isMember(env, user.id);
  const allowed = member === true && (user.id === build.tester_id || await isDev(env, user.id));
  if (!allowed) {
    const reason = member ? "this build isn't assigned to your account" : "you're not in the tester server";
    ctx.waitUntil(alertUpdateFailed(env, sess.build_id, user, reason));
    return page(`Update denied — ${reason}.`, false, 403);
  }
  const resolved = await resolveUpdatePackage(env, branch, currentSha);
  if (!resolved.ok) {
    ctx.waitUntil(alertUpdateFailed(env, sess.build_id, user, resolved.reason));
    return page("No update package available right now.", false, 404);
  }
  if (resolved.upToDate) return page("You're already up to date.", true);

  sess.status = "done"; sess.authorized = true; sess.user_id = user.id;
  sess.update_key = resolved.key; sess.update_mode = resolved.mode; sess.update_target_sha = resolved.targetSha;
  sess.update_package_sha256 = resolved.packageSha256; sess.update_verify = resolved.verify;
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: updateTtl(env) });
  return page("Update authorized. Return to the game.", true);
}

export async function latestVersion(url: URL, env: Env): Promise<Response> {
  const requested = (url.searchParams.get("branch") || "main").trim();
  if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(requested)) return json({ error: "bad branch" }, 400);
  const branch = await resolveTrackingBranch(env, requested);
  const obj = await env.BUILDS_R2.get(`base/${branch}/latest.json`);
  if (!obj) return json({ error: "no base build for branch" }, 404);
  const data = (await obj.json()) as { branch: string; sha: string; prev_sha: string | null };
  return json({ branch: data.branch, sha: data.sha });
}
