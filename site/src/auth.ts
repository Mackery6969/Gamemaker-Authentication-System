// The core Discord-OAuth verification flow: create a session, handle
// Discord's redirect back, and let the game poll for the verdict. Also
// dispatches to downloads.ts/updates.ts for their variants of the same
// redirect dance (same `state`-keyed Session, different `kind`).
import type { Env, Session } from "./types";
import { json, esc, sign, safeEqual, randState, page, ttl, logEvent } from "./util";
import { DISCORD, UA, authorizeUrl, isMember, isDev, alertDenied } from "./discord";
import { getBuild, tokenAuthorizedFor, signDeviceToken, verifyDeviceToken, type Build } from "./builds";
import { downloadAuth } from "./downloads";
import { updateAuth } from "./updates";

export async function createSession(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { build_id?: string; device_token?: string };
  const buildId = (body.build_id || "").trim();
  const build = buildId ? await getBuild(env, buildId) : null;
  if (!buildId || !build) return json({ error: "unknown build" }, 404);

  const state = randState();

  const decoded = body.device_token ? await verifyDeviceToken(env, body.device_token) : null;
  if (await tokenAuthorizedFor(env, decoded, build)) {
    const sess: Session = {
      build_id: buildId, created: Date.now(), status: "done",
      verdict: "allow", user_id: build.tester_id, username: build.label,
      sig: await sign(env.SIGNING_SECRET, `${state}|allow|${build.tester_id}`),
    };
    await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: ttl(env) });
    await logEvent(env, {
      build_id: buildId, build_tester_id: build.tester_id, build_label: build.label,
      verified_tester_id: decoded!.tester_id, cached: true,
      ip: req.headers.get("cf-connecting-ip") || undefined, verdict: "allow",
    });
    return json({ state, cached: true, poll_url: `${env.PUBLIC_BASE_URL}/api/result?state=${state}` });
  }

  const sess: Session = { build_id: buildId, created: Date.now(), status: "pending" };
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: ttl(env) });

  return json({
    state,
    authorize_url: authorizeUrl(env, state),
    poll_url: `${env.PUBLIC_BASE_URL}/api/result?state=${state}`,
  });
}

export async function callback(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const raw = await env.SESSIONS.get(state);
  if (!raw) return page("Invalid or expired session.", false, 400);
  const sess = JSON.parse(raw) as Session;
  if (sess.status !== "pending") return page("This session was already used.", false, 400);
  if (!code) { await finalize(env, state, sess, null, null, null, "error"); return page("Login was cancelled.", false, 400); }

  let user: { id: string; username?: string };
  try {
    const tok = await fetch(`${DISCORD}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: env.OAUTH_REDIRECT_URI,
      }),
    });
    if (!tok.ok) throw new Error(`token ${tok.status}`);
    const access = (await tok.json() as { access_token: string }).access_token;
    const me = await fetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${access}`, "User-Agent": UA } });
    if (!me.ok) throw new Error(`me ${me.status}`);
    user = await me.json();
  } catch {
    return page("Discord login failed. Try again.", false, 400);
  }

  if (sess.kind === "download") return await downloadAuth(env, state, sess, user, ctx);
  if (sess.kind === "update") return await updateAuth(env, state, sess, user, ctx);

  const build = (await getBuild(env, sess.build_id))!;
  const member = await isMember(env, user.id);
  const dev = member === true ? await isDev(env, user.id) : false;
  let outcome: "allow" | "deny" | "error";
  const guildOnly = env.GUILD_ONLY === "true";
  if (member === null) outcome = "error";
  else if (member && (guildOnly || dev || user.id === build.tester_id)) outcome = "allow";
  else outcome = "deny";

  await finalize(env, state, sess, user, build, member, outcome, dev);

  if (outcome === "allow") return page(`Verified as ${esc(user.username || user.id)}. Return to the game.`, true);
  if (outcome === "error") return page("Couldn't verify your membership right now — relaunch the game to try again.", false);
  const reason = member ? "this build is not assigned to your account" : "you are not in the tester server";
  ctx.waitUntil(alertDenied(env, sess.build_id, user, reason));
  return page(`Access denied — ${reason}.`, false);
}

async function finalize(
  env: Env, state: string, sess: Session,
  user: { id: string; username?: string } | null,
  build: Build | null, member: boolean | null,
  outcome: "allow" | "deny" | "error", isDevFlag = false,
) {
  sess.status = outcome === "error" ? "error" : "done";
  sess.verdict = outcome;
  sess.user_id = user?.id;
  sess.username = user?.username;
  sess.in_guild = member === true;
  sess.sig = await sign(env.SIGNING_SECRET, `${state}|${outcome}|${user?.id ?? ""}`);
  if (outcome === "allow" && user) sess.device_token = await signDeviceToken(env, user.id);
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: ttl(env) });

  await logEvent(env, {
    build_id: sess.build_id,
    build_tester_id: build?.tester_id, build_label: build?.label,
    user_id: user?.id, username: user?.username, in_guild: member === true,
    is_dev: isDevFlag, verdict: outcome,
  });
}

export async function result(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") || "";
  const raw = await env.SESSIONS.get(state);
  if (!raw) return json({ status: "expired" });
  const sess = JSON.parse(raw) as Session;
  if (sess.status !== "done") return json({ status: sess.status });
  if (sess.kind === "update") {
    return json({
      status: "done", verdict: sess.authorized ? "allow" : "deny",
      mode: sess.update_mode, target_sha: sess.update_target_sha,
      package_sha256: sess.update_package_sha256, verify: sess.update_verify,
      download_url: sess.authorized ? `${env.PUBLIC_BASE_URL}/download-file?state=${state}` : undefined,
    });
  }
  return json({
    status: "done", verdict: sess.verdict, user_id: sess.user_id,
    username: sess.username, sig: sess.sig, device_token: sess.device_token,
  });
}

export async function registerBuild(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { build_id?: string; tester_id?: string; label?: string };
  const buildId = (b.build_id || "").trim();
  const testerId = (b.tester_id || "").trim();
  if (!buildId || !testerId) return json({ error: "build_id and tester_id required" }, 400);
  const rec: Build = { tester_id: testerId, label: b.label || "", created: Date.now() };
  await env.BUILDS.put(`build:${buildId}`, JSON.stringify(rec));
  return json({ ok: true, build_id: buildId, ...rec });
}
