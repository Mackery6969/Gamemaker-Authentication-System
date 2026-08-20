// Thin entry point: wires the route table together and re-exports the
// BuildQueue Durable Object class (required so wrangler.toml's durable_objects
// binding can resolve it). Everything with actual logic lives in the other
// modules - this file should stay boring.
import type { Env } from "./types";
import { json, safeEqual } from "./util";
import { dmUser } from "./discord";
import { createSession, callback, result, registerBuild } from "./auth";
import { downloadStart, downloadFile, cleanupExpiredDownloads } from "./downloads";
import { createUpdateSession, createUpdateSessionFast, listBranches, latestVersion } from "./updates";
import { interactions } from "./interactions";
import {
  BuildQueue, queuePump, mentionGenerate, agentComplete, agentFail,
  queueComplete, queueProtect, adminQueue, adminEnqueue, adminCancelBranch, adminPushSignal,
} from "./queue";

export { BuildQueue };

// Kept here rather than in a shared module - it's a one-off admin endpoint
// with no other consumers, unlike everything re-exported above.
async function adminLogs(req: Request, url: URL, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const limit = Math.min(1000, parseInt(url.searchParams.get("limit") || "100", 10));
  const list = await env.BUILDS.list({ prefix: "log:", limit });
  const out: Array<{ ts: number; [k: string]: unknown }> = [];
  for (const k of list.keys) {
    const v = await env.BUILDS.get(k.name);
    if (v) out.push(JSON.parse(v));
  }
  out.sort((a, b) => b.ts - a.ts);
  return json({ count: out.length, logs: out });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    try {
      if (req.method === "GET" && pathname === "/api/health") return json({ ok: true });
      if (req.method === "GET" && pathname === "/api/latest") return await latestVersion(url, env);
      if (req.method === "GET" && pathname === "/api/branches") return await listBranches(env);
      if (req.method === "POST" && pathname === "/api/session") return await createSession(req, env);
      if (req.method === "POST" && pathname === "/api/update-session") return await createUpdateSession(req, env);
      if (req.method === "POST" && pathname === "/api/update-session-fast") return await createUpdateSessionFast(req, env);
      if (req.method === "GET" && pathname === "/callback") return await callback(url, env, ctx);
      if (req.method === "GET" && pathname === "/api/result") return await result(url, env);
      if (req.method === "POST" && pathname === "/interactions") return await interactions(req, env, ctx);
      if (req.method === "POST" && pathname === "/api/mention-generate") return await mentionGenerate(req, env);
      if (req.method === "POST" && pathname === "/api/agent/complete") return await agentComplete(req, env);
      if (req.method === "POST" && pathname === "/api/agent/fail") return await agentFail(req, env);
      if (req.method === "POST" && pathname === "/api/agent/queue-complete") return await queueComplete(req, env);
      if (req.method === "POST" && pathname === "/api/agent/queue-protect") return await queueProtect(req, env);
      if (req.method === "GET" && pathname.startsWith("/download/")) {
        return await downloadStart(decodeURIComponent(pathname.slice("/download/".length)), env);
      }
      if (req.method === "GET" && pathname === "/download-file") return await downloadFile(req, url, env, ctx);
      if (req.method === "POST" && pathname === "/api/admin/register-build") return await registerBuild(req, env);
      if (req.method === "GET" && pathname === "/api/admin/logs") return await adminLogs(req, url, env);
      if (req.method === "GET" && pathname === "/api/admin/queue") return await adminQueue(req, url, env);
      if (req.method === "POST" && pathname === "/api/admin/queue") return await adminEnqueue(req, env);
      if (req.method === "POST" && pathname === "/api/admin/cancel-branch") return await adminCancelBranch(req, env);
      if (req.method === "POST" && pathname === "/api/admin/push-signal") return await adminPushSignal(req, env);
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "server error" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await queuePump(env);
    await cleanupExpiredDownloads(env, dmUser);
  },
};
