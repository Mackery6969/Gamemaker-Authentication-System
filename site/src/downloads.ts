// R2-backed build-download hosting: one-time signed-in download links,
// range-request support, and the buffer/cleanup lifecycle after a download
// completes.
import type { Env, Session } from "./types";
import { getBuild } from "./builds";
import {
  randState,
  page,
  ttl,
  r2DownloadResponse,
  parseByteRange,
  autoCloseScript,
} from "./util";
import {
  authorizeUrl,
  isMember,
  isDev,
  alertDenied,
  alertMintFailed,
} from "./discord";
import {
  parseZipDirectory,
  planStoredAppend,
  ZipUnsupported,
  ZIP_TAIL_PROBE,
  type ZipDirectory,
} from "./zipmint";
import {
  loadIdTemplate,
  stampBuildId,
  deriveIdKey,
  deriveBuildSig,
  StampError,
  ID_DLL_ENTRY,
} from "./antileakid";

export interface Download {
  build_id: string;
  tester_id: string;
  status: "queued" | "building" | "ready" | "downloaded" | "used" | "failed";
  key?: string;
  created: number;
  downloaded_at?: number;
  delete_after?: number;
  base_key?: string;
}

export const DL_TTL = 60 * 60 * 6;
const DOWNLOADED_DELETE_BUFFER_MS = 30 * 60 * 1000;
export const dlGet = (env: Env, token: string) =>
  env.BUILDS.get<Download>(`dl:${token}`, "json");
export const dlPut = (env: Env, token: string, d: Download) =>
  env.BUILDS.put(`dl:${token}`, JSON.stringify(d), { expirationTtl: DL_TTL });

export function downloadDeleteAfter(d: Download): number {
  return (
    d.delete_after ||
    (d.downloaded_at || d.created) + DOWNLOADED_DELETE_BUFFER_MS
  );
}

export function downloadBufferExpired(d: Download, now = Date.now()): boolean {
  return d.status === "downloaded" && downloadDeleteAfter(d) <= now;
}

function concatStream(
  parts: Array<ReadableStream<Uint8Array> | Uint8Array>,
): ReadableStream<Uint8Array> {
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (i >= parts.length) {
          controller.close();
          return;
        }
        const part = parts[i];
        if (part instanceof Uint8Array) {
          i++;
          if (part.length) {
            controller.enqueue(part);
            return;
          }
          continue;
        }
        if (!reader) reader = part.getReader();
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          i++;
          continue;
        }
        if (value && value.length) {
          controller.enqueue(value);
          return;
        }
      }
    },
    async cancel(reason) {
      if (reader) await reader.cancel(reason).catch(() => {});
      for (let k = reader ? i + 1 : i; k < parts.length; k++) {
        const p = parts[k];
        if (!(p instanceof Uint8Array)) await p.cancel(reason).catch(() => {});
      }
    },
  });
}

interface BaseLayout {
  dir: ZipDirectory;
  cdBytes: Uint8Array;
  size: number;
}

const baseLayoutCache = new Map<string, BaseLayout>();

async function loadBaseLayout(
  bucket: R2Bucket,
  key: string,
): Promise<BaseLayout | null> {
  const head = await bucket.head(key);
  if (!head) return null;

  const cacheKey = `${key}:${head.etag}`;
  const hit = baseLayoutCache.get(cacheKey);
  if (hit) return hit;

  const probe = Math.min(ZIP_TAIL_PROBE, head.size);
  const tailObj = await bucket.get(key, {
    range: { offset: head.size - probe, length: probe },
  });
  if (!tailObj) return null;
  const dir = parseZipDirectory(
    new Uint8Array(await tailObj.arrayBuffer()),
    head.size,
  );

  const cdObj = await bucket.get(key, {
    range: { offset: dir.cdOffset, length: dir.cdSize },
  });
  if (!cdObj) return null;

  const layout: BaseLayout = {
    dir,
    cdBytes: new Uint8Array(await cdObj.arrayBuffer()),
    size: head.size,
  };
  if (baseLayoutCache.size > 8) baseLayoutCache.clear();
  baseLayoutCache.set(cacheKey, layout);
  return layout;
}

export async function mintedZipResponse(
  req: Request,
  env: Env,
  baseKey: string,
  buildId: string,
  filename: string,
): Promise<Response | null> {
  const layout = await loadBaseLayout(env.BUILDS_R2, baseKey);
  if (!layout) return null;

  const template = await loadIdTemplate(env.BUILDS_R2);
  const idKey = await deriveIdKey(env.SIGNING_SECRET, buildId);
  const idSig = await deriveBuildSig(env.SIGNING_SECRET, buildId);
  const minted = planStoredAppend(
    layout.dir,
    layout.cdBytes,
    ID_DLL_ENTRY,
    stampBuildId(template, buildId, idKey, idSig),
  );

  const parsedRange = parseByteRange(
    req.headers.get("range"),
    minted.totalSize,
  );
  const headers = new Headers({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });

  if (parsedRange === "invalid") {
    headers.set("content-range", `bytes */${minted.totalSize}`);
    return new Response("Range Not Satisfiable", { status: 416, headers });
  }

  const start = parsedRange ? parsedRange.offset : 0;
  const length = parsedRange ? parsedRange.length : minted.totalSize;
  const end = start + length - 1;

  const parts: Array<ReadableStream<Uint8Array> | Uint8Array> = [];
  if (start < minted.baseLength) {
    const baseEnd = Math.min(end, minted.baseLength - 1);
    const obj = await env.BUILDS_R2.get(baseKey, {
      range: { offset: start, length: baseEnd - start + 1 },
    });
    if (!obj) return null;
    parts.push(obj.body);
  }
  if (end >= minted.baseLength) {
    const from = Math.max(start, minted.baseLength) - minted.baseLength;
    parts.push(minted.tail.subarray(from, end - minted.baseLength + 1));
  }

  headers.set("content-length", String(length));
  if (parsedRange) {
    headers.set("content-range", `bytes ${start}-${end}/${minted.totalSize}`);
    return new Response(concatStream(parts), { status: 206, headers });
  }
  return new Response(concatStream(parts), { headers });
}

export async function downloadStart(
  token: string,
  env: Env,
): Promise<Response> {
  const d = await dlGet(env, token);
  if (!d) return page("This download link is invalid or expired.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page(
      "This build's download buffer expired. Run /generate again for a new copy.",
      false,
      410,
    );
  }
  if (d.status === "downloaded") d.status = "ready";
  if (d.status !== "ready")
    return page(
      "Your build isn't ready yet — check back in a moment.",
      false,
      425,
    );
  const state = randState();
  const sess: Session = {
    build_id: d.build_id,
    created: Date.now(),
    status: "pending",
    kind: "download",
    token,
  };
  await env.SESSIONS.put(state, JSON.stringify(sess), {
    expirationTtl: ttl(env),
  });
  return Response.redirect(authorizeUrl(env, state), 302);
}

export async function downloadAuth(
  env: Env,
  state: string,
  sess: Session,
  user: { id: string; username?: string },
  ctx: ExecutionContext,
): Promise<Response> {
  const d = sess.token ? await dlGet(env, sess.token) : null;
  if (!d) return page("This download link expired.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page("This build's download buffer expired.", false, 410);
  }
  if (d.status === "downloaded") d.status = "ready";
  const member = await isMember(env, user.id);
  const allowed =
    member === true && (user.id === d.tester_id || (await isDev(env, user.id)));
  if (!allowed) {
    const reason = member
      ? "this build isn't assigned to your account"
      : "you're not in the tester server";
    ctx.waitUntil(alertDenied(env, d.build_id, user, `download — ${reason}`));
    return page(`Download denied — ${reason}.`, false, 403);
  }
  sess.status = "done";
  sess.authorized = true;
  sess.user_id = user.id;
  await env.SESSIONS.put(state, JSON.stringify(sess), {
    expirationTtl: ttl(env),
  });
  return downloadStartedPage(
    `${env.PUBLIC_BASE_URL}/download-file?state=${state}`,
  );
}

function downloadStartedPage(fileUrl: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Antileak</title>
<style>body{background:#2b2d31;color:#fff;font-family:system-ui,sans-serif;display:flex;
height:100vh;align-items:center;justify-content:center;margin:0}.c{text-align:center;padding:2rem}
.i{font-size:3rem}h1{color:#3ba55d;margin:.4rem 0}p{color:#b5bac1}</style></head>
<body><div class="c"><div class="i">✅</div><h1>Download started</h1>
<p>Your build is downloading. This tab will close itself in a minute — or you can close it now.</p></div>
<iframe style="display:none" src="${fileUrl}"></iframe>
${autoCloseScript(2000)}</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function buildFilename(env: Env, d: Download): Promise<string> {
  const build = await getBuild(env, d.build_id);
  const label = (build?.label || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  return `build-${label || d.build_id}.zip`;
}

export async function downloadFile(
  req: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const state = url.searchParams.get("state") || "";
  const raw = await env.SESSIONS.get(state);
  if (!raw)
    return page("Download session expired — open the link again.", false, 400);
  const sess = JSON.parse(raw) as Session;

  if (sess.kind === "update") {
    if (!sess.authorized || !sess.update_key)
      return page("Not authorized.", false, 403);
    const filename = sess.update_key.split("/").pop() || "update.bin";
    const response = await r2DownloadResponse(
      req,
      env.BUILDS_R2,
      sess.update_key,
      "application/octet-stream",
      filename,
    );
    return (
      response ||
      page("Update file not found (already cleaned up).", false, 404)
    );
  }

  if (sess.kind !== "download" || !sess.authorized || !sess.token)
    return page("Not authorized.", false, 403);
  const d = await dlGet(env, sess.token);
  if (!d || (!d.key && !d.base_key))
    return page("Build file is gone.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page("This build's download buffer expired.", false, 410);
  }
  if (d.status === "downloaded") d.status = "ready";
  const downloadedAt = d.downloaded_at || Date.now();
  d.status = "downloaded";
  d.downloaded_at = downloadedAt;
  d.delete_after = d.delete_after || downloadedAt + DOWNLOADED_DELETE_BUFFER_MS;
  await dlPut(env, sess.token, d);

  const filename = await buildFilename(env, d);

  if (d.base_key) {
    try {
      const minted = await mintedZipResponse(
        req,
        env,
        d.base_key,
        d.build_id,
        filename,
      );
      if (minted) return minted;
      console.warn(`mint: base package ${d.base_key} is missing`);
    } catch (e) {
      const reason =
        e instanceof ZipUnsupported || e instanceof StampError
          ? e.message
          : String(e);
      console.error(
        `mint: failed for ${d.build_id} from ${d.base_key}: ${reason}`,
      );
      _ctx.waitUntil(alertMintFailed(env, d.build_id, d.base_key, reason));
    }
    if (!d.key) {
      return page(
        "Couldn't assemble your build just now — the devs have been alerted. Try the link again shortly.",
        false,
        500,
      );
    }
  }

  if (!d.key) return page("Build file is gone.", false, 404);
  const response = await r2DownloadResponse(
    req,
    env.BUILDS_R2,
    d.key,
    "application/zip",
    filename,
  );
  return (
    response || page("Build file not found (already cleaned up).", false, 404)
  );
}

export async function cleanupExpiredDownloads(
  env: Env,
  dmUser: (env: Env, userId: string, content: string) => Promise<void>,
): Promise<void> {
  const now = Date.now();
  const stuckBefore = now - 30 * 60 * 1000;
  const protectedKeys = new Set<string>();
  const dls = await env.BUILDS.list({ prefix: "dl:" });
  for (const k of dls.keys) {
    const d = await env.BUILDS.get<Download>(k.name, "json");
    if (d && d.status === "building" && d.created < stuckBefore) {
      d.status = "failed";
      await env.BUILDS.put(k.name, JSON.stringify(d), {
        expirationTtl: DL_TTL,
      });
      await dmUser(env, d.tester_id, "⛔ Build failed! Ping a dev!");
      console.log("cron: stuck build -> failed", d.build_id);
    }
    if (d?.key && d.status === "downloaded") {
      const deleteAfter = downloadDeleteAfter(d);
      d.delete_after = deleteAfter;
      if (env.BUILDS_R2 && deleteAfter <= now) {
        await env.BUILDS_R2.delete(d.key);
        d.status = "used";
        await dlPut(env, k.name.slice("dl:".length), d);
        console.log("cron cleaned downloaded build after buffer", d.key);
      } else {
        protectedKeys.add(d.key);
      }
    }
  }

  if (!env.BUILDS_R2) return;
  const cutoff = now - DL_TTL * 1000;
  const list = await env.BUILDS_R2.list({ prefix: "builds/" });
  for (const o of list.objects) {
    if (!protectedKeys.has(o.key) && o.uploaded.getTime() < cutoff) {
      await env.BUILDS_R2.delete(o.key);
      console.log("cron cleaned old build", o.key);
    }
  }
}
