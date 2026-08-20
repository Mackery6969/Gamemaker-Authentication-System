import { DurableObject } from "cloudflare:workers";

export interface Env {
  SESSIONS: KVNamespace;
  BUILDS: KVNamespace;
  BUILDS_R2: R2Bucket;
  BUILD_QUEUE: DurableObjectNamespace<BuildQueue>;
  TESTER_GUILD_ID: string;
  ALERT_CHANNEL_ID: string;
  BUILD_LOG_CHANNEL_ID: string;
  DEV_IDS: string;
  DEV_ROLE_IDS: string;
  GUILD_ONLY: string;
  GENERATE_ENABLED: string;
  GENERATE_ALLOWLIST: string;
  MENTION_ENABLED: string;
  OAUTH_REDIRECT_URI: string;
  PUBLIC_BASE_URL: string;
  SESSION_TTL: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  ADMIN_API_KEY: string;
  SIGNING_SECRET: string;
  DISCORD_PUBLIC_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  AVAILABLE_BRANCHES: string;
  INCLUDE_PR_BRANCHES: string;
  TESTABLE_BRANCH: string;
}

const DISCORD = "https://discord.com/api/v10";
// Discord asks for a descriptive User-Agent identifying your app; point this at your own project/repo URL.
const UA = "DiscordBot (https://github.com/your-org/your-repo, 1.0)";
const GH_API_VERSION = "2026-03-10";
const QUEUE_WORKFLOW_NAMES = ["tester-build", "base-build", "compile", "clear-gm-cache"] as const;
const QUEUE_WORKFLOW_REF = "main";
const GITHUB_ACTIVE_RUN_STATUSES = ["requested", "waiting", "pending", "queued", "in_progress"] as const;
const QUEUE_POLL_MS = 60 * 1000;
const QUEUE_DISPATCH_GRACE_MS = 90 * 1000;
const QUEUE_PRIORITY_SETTLE_MS = 30 * 1000;
const QUEUE_IMMEDIATE_PRIORITY = 10;
const QUEUE_ITEM_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_QUEUE_PRIORITIES: Record<QueueDispatchType, number> = {
  "base-build": 30,
  "tester-build": 20,
  compile: 50,
  "clear-gm-cache": 80,
};
const SUPERSEDES: Partial<Record<QueueDispatchType, QueueDispatchType[]>> = {
  "base-build": ["compile"],
};

interface Build { tester_id: string; label: string; created: number }
interface Session {
  build_id: string; created: number; status: "pending" | "done" | "expired" | "error";
  verdict?: "allow" | "deny" | "error"; user_id?: string; username?: string;
  in_guild?: boolean; sig?: string; device_token?: string;
  kind?: "verify" | "download" | "update"; token?: string; authorized?: boolean;
  update_branch?: string; update_current_sha?: string;
  update_key?: string; update_mode?: "patch" | "full"; update_target_sha?: string;
  update_package_sha256?: string; update_verify?: VerifyFile[];
}
interface VerifyFile { path: string; sha256: string }
interface Download {
  build_id: string; tester_id: string; status: "queued" | "building" | "ready" | "downloaded" | "used" | "failed";
  key?: string; created: number; downloaded_at?: number; delete_after?: number;
}

type QueueDispatchType = "tester-build" | "base-build" | "compile" | "clear-gm-cache";
type DirectDispatchType = "sync-pr-with-main";
type DispatchType = QueueDispatchType | DirectDispatchType;
type QueueStatus = "queued" | "dispatching" | "dispatched" | "canceling" | "done" | "failed" | "canceled";
type QueuePayloadValue = string | number | boolean | null;
type QueuePayload = Record<string, QueuePayloadValue | undefined>;

interface QueueItemInput {
  id?: string;
  type: QueueDispatchType;
  priority?: number;
  payload?: QueuePayload;
  requested_by?: string;
  display?: string;
  dedupe_key?: string;
}

interface QueueItem {
  id: string;
  run_id?: number;
  type: QueueDispatchType;
  priority: number;
  created: number;
  status: QueueStatus;
  payload: QueuePayload;
  display: string;
  requested_by?: string;
  dedupe_key?: string;
  dispatched_at?: number;
  completed_at?: number;
  cancel_protected_at?: number;
  gh_run_id?: number;
  cancel_requested_at?: number;
  error?: string;
}

interface QueuePumpResult {
  dispatched: boolean;
  reason: string;
  item?: QueueItem;
  active_runs?: number;
  blocked_reason?: string;
}

interface QueueEnqueueResult {
  ok: boolean;
  item: QueueItem;
  position: number | null;
  pump: QueuePumpResult;
}

interface QueueListResult {
  items: QueueItem[];
  total: number;
}

interface QueueHistoryResult {
  items: QueueItem[];
}

interface QueueCancelByBranchResult {
  canceled: number;
  items: QueueItem[];
  skipped_protected: QueueItem[];
  github: string[];
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });

const ttl = (env: Env) => Math.max(60, parseInt(env.SESSION_TTL || "600", 10));
const updateTtl = (env: Env) => Math.max(ttl(env), 60 * 60);

type ParsedByteRange = { offset: number; length: number; end: number };

function parseByteRange(header: string | null, size: number): ParsedByteRange | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";

  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw === "") return "invalid";
  if (!Number.isSafeInteger(size) || size < 0) return "invalid";

  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "invalid";
    const length = Math.min(suffix, size);
    const offset = size - length;
    return { offset, length, end: size - 1 };
  }

  const offset = Number(startRaw);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return "invalid";

  const requestedEnd = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return "invalid";
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1, end };
}

async function r2DownloadResponse(
  req: Request,
  bucket: R2Bucket,
  key: string,
  contentType: string,
  filename: string,
): Promise<Response | null> {
  const head = await bucket.head(key);
  if (!head) return null;

  const parsedRange = parseByteRange(req.headers.get("range"), head.size);
  const baseHeaders = new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  });

  if (parsedRange === "invalid") {
    baseHeaders.set("content-range", `bytes */${head.size}`);
    return new Response("Range Not Satisfiable", { status: 416, headers: baseHeaders });
  }

  const obj = await bucket.get(key, parsedRange ? { range: { offset: parsedRange.offset, length: parsedRange.length } } : undefined);
  if (!obj) return null;

  if (parsedRange) {
    baseHeaders.set("content-length", String(parsedRange.length));
    baseHeaders.set("content-range", `bytes ${parsedRange.offset}-${parsedRange.end}/${head.size}`);
    return new Response(obj.body, { status: 206, headers: baseHeaders });
  }

  baseHeaders.set("content-length", String(head.size));
  return new Response(obj.body, { headers: baseHeaders });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const devIds = (env: Env) =>
  new Set((env.DEV_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const devRoleIds = (env: Env) =>
  new Set((env.DEV_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const availableBranches = (env: Env) =>
  new Set((env.AVAILABLE_BRANCHES || "").split(",").map((s) => s.trim()).filter(Boolean));

function randState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authorizeUrl(env: Env, state: string): string {
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: "code", scope: "identify", state,
  });
  return `${DISCORD}/oauth2/authorize?${q}`;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

function getBuild(env: Env, id: string) {
  return env.BUILDS.get<Build>(`build:${id}`, "json");
}

const DL_TTL = 60 * 60 * 6;
const DOWNLOADED_DELETE_BUFFER_MS = 30 * 60 * 1000;
const dlGet = (env: Env, token: string) => env.BUILDS.get<Download>(`dl:${token}`, "json");
const dlPut = (env: Env, token: string, d: Download) =>
  env.BUILDS.put(`dl:${token}`, JSON.stringify(d), { expirationTtl: DL_TTL });

const DEVICE_TOKEN_TTL_MS = 60 * 60 * 24 * 1000;

async function signDeviceToken(env: Env, testerId: string): Promise<string> {
  const payload = btoa(JSON.stringify({ tester_id: testerId, exp: Date.now() + DEVICE_TOKEN_TTL_MS }));
  return `${payload}.${await sign(env.SIGNING_SECRET, payload)}`;
}

async function verifyDeviceToken(env: Env, token: string): Promise<{ tester_id: string } | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await sign(env.SIGNING_SECRET, payload))) return null;
  try {
    const data = JSON.parse(atob(payload)) as { tester_id?: string; exp?: number };
    if (!data.tester_id || !data.exp || data.exp < Date.now()) return null;
    return { tester_id: data.tester_id };
  } catch {
    return null;
  }
}

function downloadDeleteAfter(d: Download): number {
  return d.delete_after || ((d.downloaded_at || d.created) + DOWNLOADED_DELETE_BUFFER_MS);
}

function downloadBufferExpired(d: Download, now = Date.now()): boolean {
  return d.status === "downloaded" && downloadDeleteAfter(d) <= now;
}

async function isMember(env: Env, uid: string): Promise<boolean | null> {
  const r = await fetch(`${DISCORD}/guilds/${env.TESTER_GUILD_ID}/members/${uid}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": UA },
  });
  if (r.status === 200) return true;
  if (r.status === 404) return false;
  console.warn(`membership check error ${r.status} for ${uid}`);
  return null;
}

async function isDev(env: Env, uid: string): Promise<boolean> {
  if (devIds(env).has(uid)) return true;
  const roles = devRoleIds(env);
  if (roles.size === 0) return false;
  const r = await fetch(`${DISCORD}/guilds/${env.TESTER_GUILD_ID}/members/${uid}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": UA },
  });
  if (r.status !== 200) return false;
  const m = (await r.json()) as { roles?: string[] };
  return (m.roles || []).some((rid) => roles.has(rid));
}

async function tokenAuthorizedFor(env: Env, decoded: { tester_id: string } | null, build: Build): Promise<boolean> {
  if (!decoded) return false;
  if (decoded.tester_id === build.tester_id) return (await isMember(env, decoded.tester_id)) === true;
  return isDev(env, decoded.tester_id);
}

function randId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

async function verifyDiscordSig(req: Request, body: string, env: Env): Promise<boolean> {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" }, key, hexToBytes(sig), new TextEncoder().encode(ts + body),
    );
  } catch (e) {
    console.error("sig verify error", e);
    return false;
  }
}

const ephem = (content: string) => json({ type: 4, data: { content, flags: 64 } });

async function dmUser(env: Env, userId: string, content: string): Promise<void> {
  try {
    const ch = await fetch(`${DISCORD}/users/@me/channels`, {
      method: "POST",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ recipient_id: userId }),
    });
    if (!ch.ok) { console.error("dm channel open failed", ch.status); return; }
    const channel = (await ch.json()) as { id: string };
    await fetch(`${DISCORD}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ content }),
    });
  } catch (e) {
    console.error("dm error", e);
  }
}

async function postToChannel(env: Env, channelId: string, content: string): Promise<void> {
  if (!channelId) return;
  try {
    const r = await fetch(`${DISCORD}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) console.error("channel post failed", channelId, r.status, await r.text());
  } catch (e) {
    console.error("channel post error", e);
  }
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

async function postEmbedToChannel(env: Env, channelId: string, embed: DiscordEmbed): Promise<void> {
  if (!channelId) return;
  try {
    const r = await fetch(`${DISCORD}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) console.error("embed post failed", channelId, r.status, await r.text());
  } catch (e) {
    console.error("embed post error", e);
  }
}

const EMBED_COLOR_SUCCESS = 0x2ecc71;
const EMBED_COLOR_FAILURE = 0xe74c3c;

async function notifyBuildComplete(env: Env, item: QueueItem): Promise<void> {
  const ok = item.status === "done";
  const branch = queueRef(item.payload);
  const sha = shortSha(queueSha(item.payload));
  const runUrl = item.gh_run_id ? `https://github.com/${env.GITHUB_REPO}/actions/runs/${item.gh_run_id}` : undefined;

  const fields: DiscordEmbed["fields"] = [{ name: "Branch", value: branch || "?", inline: true }];
  if (sha) fields.push({ name: "Commit", value: `\`${sha}\``, inline: true });
  if (item.requested_by) fields.push({ name: "Requested by", value: item.requested_by, inline: true });
  if (item.dispatched_at) {
    fields.push({ name: "Duration", value: fmtDur((item.completed_at || Date.now()) - item.dispatched_at), inline: true });
  }
  if (!ok && item.error) fields.push({ name: "Error", value: item.error.slice(0, 1000) });

  await postEmbedToChannel(env, env.BUILD_LOG_CHANNEL_ID, {
    title: `${ok ? "✅" : "❌"} ${item.type} ${ok ? "succeeded" : "failed"}`,
    description: item.display,
    url: runUrl,
    color: ok ? EMBED_COLOR_SUCCESS : EMBED_COLOR_FAILURE,
    fields,
    timestamp: new Date(item.completed_at || Date.now()).toISOString(),
    footer: { text: env.GITHUB_REPO },
  });
}

async function alertDenied(env: Env, buildId: string, user: { id: string; username?: string }, reason: string): Promise<void> {
  await postToChannel(
    env, env.ALERT_CHANNEL_ID,
    `⛔ **Auth denied** — **${user.username ?? user.id}** (<@${user.id}>, \`${user.id}\`) ` +
    `tried build \`${buildId}\` but was denied (${reason}).`,
  );
}

async function alertUpdateFailed(env: Env, buildId: string, user: { id: string; username?: string }, reason: string): Promise<void> {
  await postToChannel(
    env, env.ALERT_CHANNEL_ID,
    `⚠️ **Update failed** — **${user.username ?? user.id}** (<@${user.id}>, \`${user.id}\`) ` +
    `build \`${buildId}\` (${reason}).`,
  );
}

function ghHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GH_API_VERSION,
    "User-Agent": "antileak-worker",
  };
}

function githubDispatchError(prefix: string, status: number, text: string): string {
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown; errors?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const fields = parsed.errors.map((err) => typeof err === "string" ? err : JSON.stringify(err)).join("; ");
      if (fields) detail = `${detail}: ${fields}`;
    }
  } catch {
    // Keep the raw text when GitHub did not send JSON.
  }
  if (detail.length > 240) detail = `${detail.slice(0, 237)}...`;
  return `${prefix} (${status}): ${detail || "request failed"}`;
}

async function dispatchRepositoryEvent(env: Env, eventType: string, clientPayload: QueuePayload): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      ...ghHeaders(env),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });
  if (r.ok) return { ok: true };
  const error = githubDispatchError("GitHub repository dispatch failed", r.status, await r.text());
  console.error(error);
  return { ok: false, error };
}

async function dispatchWorkflowEvent(
  env: Env,
  workflowId: string,
  ref: string,
  inputs?: QueuePayload,
): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: "POST",
      headers: {
        ...ghHeaders(env),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref, inputs: inputs || {} }),
    },
  );
  if (r.ok) return { ok: true };
  const error = githubDispatchError(`GitHub workflow dispatch failed for ${workflowId}@${ref}`, r.status, await r.text());
  console.error(error);
  return { ok: false, error };
}

function queuePayloadString(payload: QueuePayload, key: string): string {
  const v = payload[key];
  if (v === undefined || v === null) return "";
  return String(v);
}

function normalizeQueueBranch(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//i, "");
}

function queuePayloadBool(payload: QueuePayload, key: string): boolean {
  const v = payload[key];
  return v === true || String(v).toLowerCase() === "true" || String(v) === "1";
}

function queueRef(payload: QueuePayload): string {
  return queuePayloadString(payload, "ref") || queuePayloadString(payload, "branch") || "main";
}

function queueSha(payload: QueuePayload): string {
  return queuePayloadString(payload, "sha") || queuePayloadString(payload, "target_sha");
}

function queueItemMatchesBranch(item: QueueItem, branch: string): boolean {
  const target = normalizeQueueBranch(branch).toLowerCase();
  if (!target) return false;
  return ["branch", "ref", "target_ref"].some((key) => {
    const value = normalizeQueueBranch(queuePayloadString(item.payload, key)).toLowerCase();
    return value === target;
  });
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 12) : "";
}

function defaultQueuePriority(type: QueueDispatchType, payload: QueuePayload): number {
  if (type === "base-build" && queueRef(payload) === "main") return 10;
  return DEFAULT_QUEUE_PRIORITIES[type];
}

const STACK_PRIORITY_PENALTY = 5;

async function resolveQueuePriority(env: Env, type: QueueDispatchType, payload: QueuePayload): Promise<number> {
  const base = defaultQueuePriority(type, payload);
  if (type !== "base-build" && type !== "compile") return base;
  const branch = queueRef(payload);
  if (!branch || branch === testableBranch(env)) return base;
  const depth = await branchStackDepth(env, branch);
  return base + depth * STACK_PRIORITY_PENALTY;
}

function queueDisplay(type: QueueDispatchType, payload: QueuePayload): string {
  switch (type) {
    case "tester-build": {
      const username = queuePayloadString(payload, "username") || queuePayloadString(payload, "tester_id") || "tester";
      const buildId = queuePayloadString(payload, "build_id") || "build";
      const branch = queuePayloadString(payload, "branch");
      return `${username} (${buildId})${branch ? ` @ ${branch}` : ""}`;
    }
    case "base-build": {
      const sha = shortSha(queueSha(payload));
      return `base-build @ ${queueRef(payload)}${sha ? ` (${sha})` : ""}`;
    }
    case "compile": {
      const sha = shortSha(queueSha(payload));
      return `compile @ ${queueRef(payload)}${sha ? ` (${sha})` : ""}`;
    }
    case "clear-gm-cache": {
      const wipe = queuePayloadBool(payload, "wipe_r2_base");
      const branch = queuePayloadString(payload, "branch");
      return `clear-gm-cache${wipe ? " + R2 wipe" : ""}${branch ? ` (${branch})` : ""}`;
    }
  }
}

function queueDedupeKey(type: QueueDispatchType, payload: QueuePayload): string {
  if (type === "tester-build") return `${type}:${queuePayloadString(payload, "tester_id") || queuePayloadString(payload, "build_id")}`;
  if (type === "clear-gm-cache") return `${type}:${queuePayloadString(payload, "wipe_r2_base")}:${queuePayloadString(payload, "branch")}`;
  return `${type}:${queueRef(payload)}`;
}

function shouldCancelRunningDuplicate(type: QueueDispatchType): boolean {
  return type === "tester-build" || type === "base-build" || type === "compile";
}

function itemsShareConcurrencyGroup(a: QueueItem, b: QueueItem): boolean {
  if (a.type === b.type && shouldCancelRunningDuplicate(a.type) && !!a.dedupe_key && a.dedupe_key === b.dedupe_key) {
    return true;
  }
  return itemSupersedes(b, a);
}

function itemSupersedes(item: QueueItem, other: QueueItem): boolean {
  const supersededTypes = SUPERSEDES[item.type];
  if (!supersededTypes?.includes(other.type)) return false;
  const branch = queueRef(item.payload).toLowerCase();
  return !!branch && branch === queueRef(other.payload).toLowerCase();
}

function queueWorkflowInputs(item: QueueItem): QueuePayload {
  const targetRef = queueRef(item.payload);
  const targetSha = queueSha(item.payload);
  if (item.type !== "clear-gm-cache") {
    return { queue_id: item.id, target_ref: targetRef, target_sha: targetSha || undefined };
  }
  return {
    queue_id: item.id,
    target_ref: targetRef,
    target_sha: targetSha || undefined,
    wipe_r2_base: queuePayloadBool(item.payload, "wipe_r2_base"),
    branch: queuePayloadString(item.payload, "branch"),
  };
}

function directWorkflowInputs(type: DirectDispatchType, branch?: string): QueuePayload {
  void type; void branch;
  return {};
}

async function dispatchQueueItem(env: Env, item: QueueItem): Promise<boolean> {
  let res: { ok: boolean; error?: string };
  if (item.type === "tester-build") {
    res = await dispatchRepositoryEvent(env, "tester-build", { ...item.payload, queue_id: item.id });
  } else {
    res = await dispatchWorkflowEvent(env, `${item.type}.yml`, QUEUE_WORKFLOW_REF, queueWorkflowInputs(item));
  }
  if (!res.ok) throw new Error(res.error || "GitHub dispatch failed");
  return true;
}

function queueStub(env: Env): DurableObjectStub<BuildQueue> {
  return env.BUILD_QUEUE.getByName("github-dispatch");
}

async function queuePump(env: Env): Promise<QueuePumpResult> {
  return queueStub(env).pump();
}

async function enqueueGithubDispatch(env: Env, item: QueueItemInput): Promise<QueueEnqueueResult> {
  return queueStub(env).enqueue(item);
}

type QueueRow = Record<string, string | number | ArrayBuffer | null> & {
  id: string;
  run_id: number | null;
  type: string;
  priority: number;
  created: number;
  status: string;
  payload: string;
  display: string;
  requested_by: string | null;
  dedupe_key: string | null;
  dispatched_at: number | null;
  completed_at: number | null;
  cancel_protected_at: number | null;
  gh_run_id: number | null;
  cancel_requested_at: number | null;
  error: string | null;
};

function isQueueDispatchType(type: string): type is QueueDispatchType {
  return type === "tester-build" || type === "base-build" || type === "compile" || type === "clear-gm-cache";
}

function isDirectDispatchType(type: string): type is DirectDispatchType {
  return type === "sync-pr-with-main";
}

function isDispatchType(type: string): type is DispatchType {
  return isQueueDispatchType(type) || isDirectDispatchType(type);
}

function isOpenQueueStatus(status: QueueStatus): boolean {
  return status === "queued" || status === "dispatching" || status === "dispatched";
}

function isKnownQueueStatus(status: string): status is QueueStatus {
  return isOpenQueueStatus(status as QueueStatus) || status === "canceling" || status === "done" || status === "failed" || status === "canceled";
}

function rowToQueueItem(row: QueueRow): QueueItem {
  const status = isKnownQueueStatus(row.status) ? row.status : "failed";
  const type = isQueueDispatchType(row.type) ? row.type : "compile";
  return {
    id: row.id,
    run_id: row.run_id === null ? undefined : Number(row.run_id),
    type,
    priority: Number(row.priority),
    created: Number(row.created),
    status,
    payload: JSON.parse(row.payload || "{}") as QueuePayload,
    display: row.display,
    requested_by: row.requested_by || undefined,
    dedupe_key: row.dedupe_key || undefined,
    dispatched_at: row.dispatched_at === null ? undefined : Number(row.dispatched_at),
    completed_at: row.completed_at === null ? undefined : Number(row.completed_at),
    cancel_protected_at: row.cancel_protected_at === null ? undefined : Number(row.cancel_protected_at),
    gh_run_id: row.gh_run_id === null ? undefined : Number(row.gh_run_id),
    cancel_requested_at: row.cancel_requested_at === null ? undefined : Number(row.cancel_requested_at),
    error: row.error || undefined,
  };
}

function isCancelProtected(item: QueueItem): boolean {
  return item.type === "base-build" && item.cancel_protected_at !== undefined;
}

function cancelProtectedReason(item: QueueItem): string {
  const runId = item.run_id ?? item.id;
  return `base-build run ${runId} is past the build phase`;
}

async function markTesterDownloadForQueueItem(env: Env, item: QueueItem, status: "building" | "failed", notify = false): Promise<void> {
  if (item.type !== "tester-build") return;
  const token = queuePayloadString(item.payload, "token");
  if (!token) return;
  const d = await dlGet(env, token);
  if (!d) return;
  d.status = status;
  if (status === "building") d.created = Date.now();
  await dlPut(env, token, d);
  if (status === "failed" && notify) await dmUser(env, d.tester_id, "Build failed to start in CI. Ping a dev.");
}

function runMatchesQueueItem(run: Run, item: QueueItem): boolean {
  if (runWorkflowType(run) !== item.type) return false;
  if (item.gh_run_id) return run.id === item.gh_run_id;
  const title = (run.display_title || "").toLowerCase();
  const branch = queueRef(item.payload).toLowerCase();
  const sha = shortSha(queueSha(item.payload)).toLowerCase();
  if (branch && !title.includes(branch)) return false;
  if (sha && !title.includes(sha)) return false;
  if (item.type === "tester-build") {
    const buildId = queuePayloadString(item.payload, "build_id").toLowerCase();
    return !buildId || title.includes(buildId);
  }
  return true;
}

function runCanBeReplacedByQueueItem(run: Run, item: QueueItem): boolean {
  if (!shouldCancelRunningDuplicate(item.type) || runWorkflowType(run) !== item.type) return false;
  const title = (run.display_title || "").toLowerCase();
  if (item.type === "base-build" || item.type === "compile") {
    const branch = queueRef(item.payload).toLowerCase();
    return !!branch && title.includes(branch);
  }
  if (item.type === "tester-build") {
    const buildId = queuePayloadString(item.payload, "build_id").toLowerCase();
    return !!buildId && title.includes(buildId);
  }
  return false;
}

interface CancelAttempt {
  acknowledged: boolean;
  runId?: number;
  message: string;
}

async function cancelGitHubRunForQueueItem(env: Env, item: QueueItem): Promise<CancelAttempt> {
  if (item.gh_run_id) {
    const canceled = await cancelGitHubRunById(env, String(item.gh_run_id));
    if (canceled.run) {
      console.log(`cancel: ${item.type} ${item.id} by gh_run_id=${item.gh_run_id} -> ${canceled.message}`);
      return { acknowledged: canceled.ok, runId: item.gh_run_id, message: canceled.message };
    }
    console.log(`cancel: ${item.type} ${item.id} gh_run_id=${item.gh_run_id} didn't resolve to a real run, falling back to fuzzy match`);
  }
  const runs = await ghQueueRuns(env);
  const candidates = runs.filter((run) => runWorkflowType(run) === item.type && run.id);
  const run = candidates.find((candidate) => runMatchesQueueItem(candidate, item))
    || (candidates.length === 1 ? candidates[0] : undefined);
  if (!run?.id) {
    console.log(`cancel: ${item.type} ${item.id} (${item.display}) - no matching GitHub Actions run found among ${candidates.length} candidate(s)`);
    return { acknowledged: false, message: "no matching GitHub Actions run found" };
  }
  const canceled = await cancelGitHubRunById(env, String(run.id));
  console.log(`cancel: ${item.type} ${item.id} by fuzzy match -> run #${run.id} -> ${canceled.message}`);
  return { acknowledged: canceled.ok, runId: run.id, message: canceled.message };
}

async function resolveDispatchedRunId(env: Env, item: QueueItem, dispatchedAt: number): Promise<number | undefined> {
  const event = item.type === "tester-build" ? "repository_dispatch" : "workflow_dispatch";
  const retryDelaysMs = [0, 1500, 3000, 5000];
  for (const delay of retryDelaysMs) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const r = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?event=${event}&per_page=10`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) continue;
    const d = (await r.json()) as { workflow_runs: Run[] };
    const candidates = d.workflow_runs.filter((run) =>
      runWorkflowType(run) === item.type && run.id && new Date(run.created_at).getTime() >= dispatchedAt - 10_000,
    );
    if (candidates.length === 0) continue;
    const match = candidates.find((run) => runMatchesQueueItem(run, item))
      || (candidates.length === 1 ? candidates[0] : undefined);
    if (match?.id) {
      console.log(`resolve-run-id: ${item.type} ${item.id} -> gh run #${match.id} (attempt after ${delay}ms)`);
      return match.id;
    }
  }
  console.log(`resolve-run-id: ${item.type} ${item.id} (${item.display}) - never found a matching run, cancellation will fall back to fuzzy matching`);
  return undefined;
}

async function cancelGitHubRunsReplacedByQueueItem(env: Env, item: QueueItem): Promise<string[]> {
  if (!shouldCancelRunningDuplicate(item.type)) return [];
  const runs = await ghQueueRuns(env);
  const messages: string[] = [];
  for (const run of runs) {
    if (!run.id) continue;
    if (!runCanBeReplacedByQueueItem(run, item)) continue;
    if (runMatchesQueueItem(run, item)) continue;
    const canceled = await cancelGitHubRunById(env, String(run.id));
    messages.push(`${run.display_title || run.name || run.id}: ${canceled.message}`);
  }
  return messages;
}

export class BuildQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS queue_items (
          id TEXT PRIMARY KEY,
          run_id INTEGER,
          type TEXT NOT NULL,
          priority INTEGER NOT NULL,
          created INTEGER NOT NULL,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          display TEXT NOT NULL,
          requested_by TEXT,
          dedupe_key TEXT,
          dispatched_at INTEGER,
          completed_at INTEGER,
          cancel_protected_at INTEGER,
          gh_run_id INTEGER,
          cancel_requested_at INTEGER,
          error TEXT
        )
      `);
      try {
        this.ctx.storage.sql.exec("ALTER TABLE queue_items ADD COLUMN run_id INTEGER");
      } catch {
        // Column already exists.
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE queue_items ADD COLUMN cancel_protected_at INTEGER");
      } catch {
        // Column already exists.
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE queue_items ADD COLUMN gh_run_id INTEGER");
      } catch {
        // Column already exists.
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE queue_items ADD COLUMN cancel_requested_at INTEGER");
      } catch {
        // Column already exists.
      }
      this.ctx.storage.sql.exec("UPDATE queue_items SET run_id=rowid WHERE run_id IS NULL");
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_queue_open
        ON queue_items(status, priority, created)
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_queue_run_id
        ON queue_items(run_id)
      `);
    });
  }

  async enqueue(input: QueueItemInput): Promise<QueueEnqueueResult> {
    const now = Date.now();
    const type = input.type;
    const payload = input.payload || {};
    const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority!) : defaultQueuePriority(type, payload);
    const id = input.id || `q_${now.toString(36)}_${randId()}`;
    const runId = this.nextRunId();
    const display = input.display || queueDisplay(type, payload);
    const dedupeKey = input.dedupe_key || queueDedupeKey(type, payload);

    await this.cancelQueuedDuplicates(type, dedupeKey, now);

    this.ctx.storage.sql.exec(
      `INSERT INTO queue_items
        (id, run_id, type, priority, created, status, payload, display, requested_by, dedupe_key)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      id,
      runId,
      type,
      priority,
      now,
      JSON.stringify(payload),
      display,
      input.requested_by || null,
      dedupeKey || null,
    );

    const pump = await this.pump();
    const item = this.getItem(id) || {
      id, run_id: runId, type, priority, created: now, status: "queued", payload, display,
      requested_by: input.requested_by, dedupe_key: dedupeKey,
    };
    return { ok: item.status !== "failed", item, position: this.position(id), pump };
  }

  async list(limit = 50): Promise<QueueListResult> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status IN ('dispatching', 'dispatched', 'canceling', 'queued')
       ORDER BY
         CASE WHEN status IN ('dispatching', 'dispatched', 'canceling') THEN 0 ELSE 1 END,
         priority ASC,
         created ASC
       LIMIT ?`,
      safeLimit,
    ).toArray();
    const total = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM queue_items WHERE status IN ('dispatching', 'dispatched', 'canceling', 'queued')`,
    ).one().n;
    return { items: rows.map(rowToQueueItem), total };
  }

  async history(limit = 10): Promise<QueueHistoryResult> {
    const safeLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const rows = this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status IN ('done', 'failed', 'canceled')
       ORDER BY COALESCE(completed_at, dispatched_at, created) DESC
       LIMIT ?`,
      safeLimit,
    ).toArray();
    return { items: rows.map(rowToQueueItem) };
  }

  async cancelByTester(testerId: string): Promise<{ canceled: number }> {
    let canceled = 0;
    const rows = this.openRows(200);
    for (const row of rows) {
      const item = rowToQueueItem(row);
      if (item.type !== "tester-build" || item.status !== "queued") continue;
      if (queuePayloadString(item.payload, "tester_id") !== testerId) continue;
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='canceled', completed_at=? WHERE id=?",
        Date.now(),
        item.id,
      );
      canceled++;
    }
    if (canceled > 0) await this.scheduleOrClearAlarm();
    return { canceled };
  }

  async cancelByRunId(runId: number, reason = "canceled by dev"): Promise<{ canceled: boolean; item?: QueueItem; github?: string; reason?: string }> {
    const row = this.ctx.storage.sql.exec<QueueRow>(
      "SELECT * FROM queue_items WHERE run_id=? AND status IN ('dispatching', 'dispatched', 'queued') LIMIT 1",
      runId,
    ).toArray()[0];
    if (!row) return { canceled: false, reason: "no open queue item with that worker run id" };

    const item = rowToQueueItem(row);
    if (isCancelProtected(item)) return { canceled: false, item, reason: cancelProtectedReason(item) };

    const github = await this.cancelOpenRow(row, Date.now(), reason, true);
    await this.scheduleOrClearAlarm();
    await this.pump();
    return { canceled: true, item: this.getItem(item.id) || { ...item, status: "canceled", completed_at: Date.now(), error: reason }, github };
  }

  async cancelByBranch(branch: string, reason = "branch deleted", types?: QueueDispatchType[]): Promise<QueueCancelByBranchResult> {
    const now = Date.now();
    const target = normalizeQueueBranch(branch);
    const allowedTypes = types && types.length > 0 ? new Set(types) : undefined;
    const items: QueueItem[] = [];
    const skippedProtected: QueueItem[] = [];
    const github: string[] = [];

    for (const row of this.openRows(500)) {
      const item = rowToQueueItem(row);
      if (allowedTypes && !allowedTypes.has(item.type)) continue;
      if (!queueItemMatchesBranch(item, target)) continue;
      if (isCancelProtected(item)) {
        skippedProtected.push(item);
        continue;
      }
      const gh = await this.cancelOpenRow(row, now, reason, true);
      if (gh) github.push(gh);
      items.push(this.getItem(item.id) || { ...item, status: "canceled", completed_at: now, error: gh ? `${reason}. ${gh}` : reason });
    }

    if (items.length > 0) await this.scheduleOrClearAlarm();
    await this.pump();
    return { canceled: items.length, items, skipped_protected: skippedProtected, github };
  }

  async protectFromCancel(queueId: string): Promise<{ ok: boolean; item?: QueueItem; reason?: string }> {
    const row = this.ctx.storage.sql.exec<QueueRow>(
      "SELECT * FROM queue_items WHERE id=? AND status IN ('dispatching', 'dispatched') LIMIT 1",
      queueId,
    ).toArray()[0];
    if (!row) return { ok: false, reason: "no active queue item with that id" };

    const item = rowToQueueItem(row);
    if (item.type !== "base-build") return { ok: false, item, reason: "only base-build queue items can be protected" };

    const now = item.cancel_protected_at || Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE queue_items SET cancel_protected_at=COALESCE(cancel_protected_at, ?) WHERE id=?",
      now,
      queueId,
    );

    return { ok: true, item: this.getItem(queueId) || { ...item, cancel_protected_at: now } };
  }

  async complete(queueId?: string, dedupeKey?: string, ok = true, error = ""): Promise<{ completed: boolean }> {
    const row = this.findCompletionTarget(queueId, dedupeKey);
    if (!row) {
      await this.pump();
      return { completed: false };
    }

    const completedAt = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE queue_items SET status=?, completed_at=?, error=? WHERE id=?",
      ok ? "done" : "failed",
      completedAt,
      error || null,
      row.id,
    );
    await notifyBuildComplete(this.env, { ...rowToQueueItem(row), status: ok ? "done" : "failed", completed_at: completedAt, error: error || undefined });
    await this.pump();
    return { completed: true };
  }

  async completeTesterBuild(token: string, ok = true, error = ""): Promise<{ completed: boolean }> {
    const rows = this.openRows(200);
    for (const row of rows) {
      const item = rowToQueueItem(row);
      if (item.type !== "tester-build") continue;
      if (item.status !== "dispatching" && item.status !== "dispatched") continue;
      if (queuePayloadString(item.payload, "token") === token) return this.complete(item.id, undefined, ok, error);
    }
    await this.pump();
    return { completed: false };
  }

  async pump(): Promise<QueuePumpResult> {
    await this.failTimedOutItems(Date.now());

    const activeRuns = await ghQueueRuns(this.env);
    await this.reconcileCancelingItems(activeRuns, Date.now());

    let selected = this.nextQueuedRow();
    let selectedItem = selected ? rowToQueueItem(selected) : undefined;
    let replacementCheck = selectedItem
      ? this.canDispatchReplacement(selectedItem, activeRuns)
      : { can: false, reason: "no queued item selected" };
    let dispatchingReplacement = replacementCheck.can;
    if (!dispatchingReplacement) {
      const replacement = this.nextQueuedReplacementRow();
      if (replacement) {
        const replacementItem = rowToQueueItem(replacement);
        replacementCheck = this.canDispatchReplacement(replacementItem, activeRuns);
        if (replacementCheck.can) {
          selected = replacement;
          selectedItem = replacementItem;
          dispatchingReplacement = true;
        }
      }
    }
    if (activeRuns.length > 0) {
      if (!dispatchingReplacement) {
        console.log(`pump: github-busy, ${activeRuns.length} active run(s) - ${replacementCheck.reason}`);
        await this.scheduleOrClearAlarm();
        return { dispatched: false, reason: "github-busy", active_runs: activeRuns.length, blocked_reason: replacementCheck.reason };
      }
      console.log(`pump: replacing running duplicate for ${selectedItem?.type} ${selectedItem?.display} - ${replacementCheck.reason}`);
    }

    const now = Date.now();
    const dispatched = this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status IN ('dispatching', 'dispatched')
       ORDER BY COALESCE(dispatched_at, created) ASC`,
    ).toArray();

    for (const row of dispatched) {
      const dispatchedItem = rowToQueueItem(row);
      if (dispatchingReplacement && selectedItem && itemsShareConcurrencyGroup(dispatchedItem, selectedItem)) continue;
      const dispatchedAt = Number(row.dispatched_at || row.created);
      if (now - dispatchedAt < QUEUE_DISPATCH_GRACE_MS) {
        await this.scheduleOrClearAlarm();
        return { dispatched: false, reason: "dispatch-settling", item: dispatchedItem };
      }
      await this.scheduleOrClearAlarm();
      return { dispatched: false, reason: "waiting-for-completion", item: dispatchedItem };
    }

    if (!selected) {
      await this.scheduleOrClearAlarm();
      return { dispatched: false, reason: "idle" };
    }

    const item = selectedItem || rowToQueueItem(selected);
    if (item.priority > QUEUE_IMMEDIATE_PRIORITY && now - item.created < QUEUE_PRIORITY_SETTLE_MS) {
      await this.ctx.storage.setAlarm(now + Math.max(1000, QUEUE_PRIORITY_SETTLE_MS - (now - item.created)));
      return { dispatched: false, reason: "priority-settling", item };
    }

    this.ctx.storage.sql.exec(
      "UPDATE queue_items SET status='dispatching', dispatched_at=?, error=NULL WHERE id=?",
      now,
      item.id,
    );

    try {
      await markTesterDownloadForQueueItem(this.env, item, "building");
      if (!(await dispatchQueueItem(this.env, item))) throw new Error("GitHub dispatch failed");
      const dispatchedAt = Date.now();
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='dispatched', dispatched_at=? WHERE id=?",
        dispatchedAt,
        item.id,
      );
      const ghRunId = await resolveDispatchedRunId(this.env, item, dispatchedAt);
      if (ghRunId) {
        this.ctx.storage.sql.exec("UPDATE queue_items SET gh_run_id=? WHERE id=?", ghRunId, item.id);
      }
      const dispatchedItemWithRunId: QueueItem = { ...item, status: "dispatched", dispatched_at: dispatchedAt, gh_run_id: ghRunId };
      if (dispatchingReplacement) await this.cancelRunningDuplicatesForItem(dispatchedItemWithRunId, dispatchedAt);
      if (dispatchingReplacement) await cancelGitHubRunsReplacedByQueueItem(this.env, dispatchedItemWithRunId);
      if (dispatchingReplacement) await this.cancelSupersededItems(dispatchedItemWithRunId, dispatchedAt);
      await this.scheduleOrClearAlarm();
      return { dispatched: true, reason: "dispatched", item: dispatchedItemWithRunId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='failed', completed_at=?, error=? WHERE id=?",
        Date.now(),
        msg,
        item.id,
      );
      await markTesterDownloadForQueueItem(this.env, item, "failed", true);
      await this.scheduleOrClearAlarm();
      return { dispatched: false, reason: msg, item: { ...item, status: "failed", error: msg } };
    }
  }

  async alarm(): Promise<void> {
    await this.pump();
  }

  private openRows(limit: number): QueueRow[] {
    return this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status IN ('dispatching', 'dispatched', 'queued')
       ORDER BY
         CASE WHEN status IN ('dispatching', 'dispatched') THEN 0 ELSE 1 END,
         priority ASC,
         created ASC
       LIMIT ?`,
      limit,
    ).toArray();
  }

  private nextQueuedRow(): QueueRow | undefined {
    return this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status='queued'
       ORDER BY priority ASC, created ASC
       LIMIT 1`,
    ).toArray()[0];
  }

  private nextQueuedReplacementRow(): QueueRow | undefined {
    return this.ctx.storage.sql.exec<QueueRow>(
      `SELECT queued.* FROM queue_items queued
       WHERE queued.status='queued'
         AND queued.dedupe_key IS NOT NULL
         AND queued.type IN ('tester-build', 'base-build', 'compile')
         AND EXISTS (
           SELECT 1 FROM queue_items running
           WHERE running.status IN ('dispatching', 'dispatched')
             AND running.type=queued.type
             AND running.dedupe_key=queued.dedupe_key
         )
       ORDER BY queued.priority ASC, queued.created ASC
       LIMIT 1`,
    ).toArray()[0];
  }

  private nextRunId(): number {
    const row = this.ctx.storage.sql.exec<{ n: number | null }>(
      "SELECT COALESCE(MAX(run_id), 0) + 1 AS n FROM queue_items",
    ).one();
    return Number(row.n || 1);
  }

  private runningDuplicateRows(item: QueueItem): QueueRow[] {
    if (!shouldCancelRunningDuplicate(item.type) || !item.dedupe_key) return [];
    return this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE type=? AND dedupe_key=? AND status IN ('dispatching', 'dispatched')
       ORDER BY COALESCE(dispatched_at, created) DESC`,
      item.type,
      item.dedupe_key,
    ).toArray();
  }

  private runningRowsOfTypes(types: QueueDispatchType[]): QueueRow[] {
    if (types.length === 0) return [];
    return this.ctx.storage.sql.exec<QueueRow>(
      `SELECT * FROM queue_items
       WHERE status IN ('dispatching', 'dispatched') AND type IN (${types.map(() => "?").join(",")})`,
      ...types,
    ).toArray();
  }

  private runningSupersededItems(item: QueueItem): QueueItem[] {
    const supersededTypes = SUPERSEDES[item.type];
    if (!supersededTypes || supersededTypes.length === 0) return [];
    return this.runningRowsOfTypes(supersededTypes).map(rowToQueueItem).filter((other) => itemSupersedes(item, other));
  }

  private canDispatchReplacement(item: QueueItem, activeRuns: Run[]): { can: boolean; reason: string } {
    if (!shouldCancelRunningDuplicate(item.type)) return { can: false, reason: "type is not cancel-eligible" };
    const duplicates = this.runningDuplicateRows(item).map(rowToQueueItem);
    const protectedDupe = duplicates.find(isCancelProtected);
    if (protectedDupe) return { can: false, reason: cancelProtectedReason(protectedDupe) };

    if (duplicates.length > 0) {
      return { can: true, reason: "unprotected running duplicate tracked - GitHub concurrency will cancel it on dispatch" };
    }

    const superseded = this.runningSupersededItems(item);
    if (superseded.length > 0) {
      const names = superseded.map((s) => `${s.type} ${s.id} (${s.display})`).join(", ");
      return { can: true, reason: `supersedes running item(s) for the same branch, will cancel explicitly: ${names}` };
    }

    const sameTypeRuns = activeRuns.filter((run) => runWorkflowType(run) === item.type);
    if (sameTypeRuns.length === 0) return { can: false, reason: "no running duplicate tracked and no active runs of this type" };
    const unreplaceable = sameTypeRuns.filter((run) => !runCanBeReplacedByQueueItem(run, item));
    if (unreplaceable.length > 0) {
      const names = unreplaceable.map((run) => `${run.name}#${run.id ?? "?"} "${run.display_title || ""}"`).join(", ");
      return { can: false, reason: `active run(s) don't look replaceable by this item: ${names}` };
    }
    return { can: true, reason: "orphaned active run(s) look replaceable - GitHub concurrency will cancel on dispatch" };
  }

  private async cancelSupersededItems(item: QueueItem, now: number): Promise<void> {
    for (const other of this.runningSupersededItems(item)) {
      const row = this.ctx.storage.sql.exec<QueueRow>("SELECT * FROM queue_items WHERE id=?", other.id).toArray()[0];
      if (!row) continue;
      console.log(`pump: ${item.type} ${item.id} (${item.display}) supersedes ${other.type} ${other.id} (${other.display}) - canceling explicitly`);
      await this.cancelOpenRow(row, now, `superseded by ${item.type} for the same branch`, true);
    }
  }

  private async cancelRunningDuplicatesForItem(item: QueueItem, now: number): Promise<number> {
    let canceled = 0;
    for (const row of this.runningDuplicateRows(item)) {
      if (row.id === item.id) continue;
      if (isCancelProtected(rowToQueueItem(row))) continue;
      await this.cancelOpenRow(row, now, "replaced by a newer dispatched action", true);
      canceled++;
    }
    return canceled;
  }

  private getItem(id: string): QueueItem | null {
    const row = this.ctx.storage.sql.exec<QueueRow>("SELECT * FROM queue_items WHERE id=?", id).toArray()[0];
    return row ? rowToQueueItem(row) : null;
  }

  private position(id: string): number | null {
    const rows = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM queue_items WHERE status='queued' ORDER BY priority ASC, created ASC",
    ).toArray();
    const idx = rows.findIndex((row) => row.id === id);
    return idx < 0 ? null : idx + 1;
  }

  private findCompletionTarget(queueId?: string, dedupeKey?: string): QueueRow | null {
    if (queueId) {
      const row = this.ctx.storage.sql.exec<QueueRow>(
        "SELECT * FROM queue_items WHERE id=? AND status IN ('dispatching', 'dispatched') LIMIT 1",
        queueId,
      ).toArray()[0];
      if (row) return row;
    }
    if (dedupeKey) {
      const row = this.ctx.storage.sql.exec<QueueRow>(
        `SELECT * FROM queue_items
         WHERE dedupe_key=? AND status IN ('dispatching', 'dispatched')
         ORDER BY COALESCE(dispatched_at, created) DESC
         LIMIT 1`,
        dedupeKey,
      ).toArray()[0];
      if (row) return row;
    }
    return null;
  }

  private async cancelOpenRow(row: QueueRow, now: number, reason: string, cancelGithub: boolean): Promise<string> {
    const item = rowToQueueItem(row);
    let github = "";
    let acknowledged = false;
    let runId: number | undefined;
    if (cancelGithub && (item.status === "dispatching" || item.status === "dispatched")) {
      const attempt = await cancelGitHubRunForQueueItem(this.env, item);
      github = attempt.message;
      acknowledged = attempt.acknowledged;
      runId = attempt.runId;
      if (!acknowledged && /no matching GitHub Actions run found/.test(github)) {
        console.error(`cancelOpenRow: marking ${item.type} ${item.id} (${item.display}) canceled in DB, but its GitHub run could NOT be located/canceled - it may still be running`);
      }
    }
    const error = github ? `${reason}. ${github}` : reason;
    if (acknowledged) {
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='canceling', cancel_requested_at=?, gh_run_id=COALESCE(gh_run_id, ?), error=? WHERE id=?",
        now,
        runId ?? null,
        error,
        item.id,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='canceled', completed_at=?, gh_run_id=COALESCE(gh_run_id, ?), error=? WHERE id=?",
        now,
        runId ?? null,
        error,
        item.id,
      );
    }
    await markTesterDownloadForQueueItem(this.env, item, "failed");
    return github;
  }

  private async cancelQueuedDuplicates(type: QueueDispatchType, dedupeKey: string, now: number): Promise<number> {
    if (!dedupeKey) return 0;
    let canceled = 0;
    const rows = this.ctx.storage.sql.exec<QueueRow>(
      "SELECT * FROM queue_items WHERE type=? AND dedupe_key=? AND status='queued'",
      type,
      dedupeKey,
    ).toArray();
    for (const row of rows) {
      await this.cancelOpenRow(row, now, "replaced by a newer queued action", true);
      canceled++;
    }
    return canceled;
  }

  private async failTimedOutItems(now: number): Promise<number> {
    let failed = 0;
    const rows = this.openRows(200);
    for (const row of rows) {
      const item = rowToQueueItem(row);
      const started = item.status === "queued" ? item.created : (item.dispatched_at || item.created);
      if (now - started < QUEUE_ITEM_TIMEOUT_MS) continue;
      this.ctx.storage.sql.exec(
        "UPDATE queue_items SET status='failed', completed_at=?, error=? WHERE id=?",
        now,
        "timed out after 1 hour",
        item.id,
      );
      await notifyBuildComplete(this.env, { ...item, status: "failed", completed_at: now, error: "timed out after 1 hour" });
      await markTesterDownloadForQueueItem(this.env, item, "failed", true);
      failed++;
    }

    const stuckCanceling = this.ctx.storage.sql.exec<QueueRow>("SELECT * FROM queue_items WHERE status='canceling'").toArray();
    for (const row of stuckCanceling) {
      const item = rowToQueueItem(row);
      const requestedAt = item.cancel_requested_at || item.dispatched_at || item.created;
      if (now - requestedAt < QUEUE_ITEM_TIMEOUT_MS) continue;
      console.log(`failTimedOutItems: ${item.type} ${item.id} (${item.display}) stuck in canceling for over an hour - finalizing canceled anyway`);
      this.ctx.storage.sql.exec("UPDATE queue_items SET status='canceled', completed_at=? WHERE id=?", now, item.id);
      failed++;
    }
    return failed;
  }

  private async reconcileCancelingItems(activeRuns: Run[], now: number): Promise<void> {
    const rows = this.ctx.storage.sql.exec<QueueRow>("SELECT * FROM queue_items WHERE status='canceling'").toArray();
    for (const row of rows) {
      const item = rowToQueueItem(row);
      const stillActiveOnGitHub = item.gh_run_id
        ? activeRuns.some((run) => run.id === item.gh_run_id)
        : activeRuns.some((run) => runMatchesQueueItem(run, item));
      if (stillActiveOnGitHub) continue;

      console.log(`reconcile: ${item.type} ${item.id} (${item.display}) no longer active on GitHub - finalizing canceled`);
      this.ctx.storage.sql.exec("UPDATE queue_items SET status='canceled', completed_at=? WHERE id=?", now, item.id);
    }
  }

  private async scheduleOrClearAlarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM queue_items WHERE status IN ('dispatching', 'dispatched', 'queued') LIMIT 1",
    ).toArray()[0];
    if (row) {
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_POLL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}

async function isOpenPrBranch(env: Env, branch: string): Promise<boolean> {
  const owner = env.GITHUB_REPO.split("/")[0];
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&per_page=1`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return false;
  const prs = (await r.json()) as unknown[];
  return prs.length > 0;
}

async function openPrBaseRef(env: Env, branch: string): Promise<string | undefined> {
  const owner = env.GITHUB_REPO.split("/")[0];
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&per_page=1`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return undefined;
  const prs = (await r.json()) as { base?: { ref?: string } }[];
  return prs[0]?.base?.ref || undefined;
}

async function branchStackDepth(env: Env, branch: string, maxDepth = 5): Promise<number> {
  const testable = testableBranch(env);
  const seen = new Set<string>([branch]);
  let current = branch;
  let depth = 0;
  while (depth < maxDepth) {
    const base = await openPrBaseRef(env, current);
    if (!base || base === testable || seen.has(base)) break;
    depth++;
    current = base;
    seen.add(current);
  }
  return depth;
}

async function openPrBranches(env: Env): Promise<string[]> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&per_page=100`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return [];
  const prs = (await r.json()) as { head: { ref: string } }[];
  return prs.map((pr) => pr.head.ref);
}

async function allRepoBranches(env: Env): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/branches?per_page=100&page=${page}`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) break;
    const batch = (await r.json()) as { name: string }[];
    branches.push(...batch.map((b) => b.name));
    if (batch.length < 100) break;
  }
  return branches;
}

function testableBranch(env: Env): string {
  return env.TESTABLE_BRANCH || "main";
}

function includePrBranches(env: Env): boolean {
  return (env.INCLUDE_PR_BRANCHES || "").toLowerCase() === "true";
}

async function resolveTrackingBranch(env: Env, branch: string): Promise<string> {
  const testable = testableBranch(env);
  if (branch === testable) return testable;

  const legitimate = availableBranches(env).has(branch)
    || (includePrBranches(env) && await isOpenPrBranch(env, branch));
  if (!legitimate) return testable;

  const hasBase = await env.BUILDS_R2.head(`base/${branch}/latest.json`);
  if (!hasBase) return testable;

  return branch;
}

async function cancelRuns(env: Env, names: readonly string[] = ["tester-build"]): Promise<string> {
  try {
    const runs = (await Promise.all(GITHUB_ACTIVE_RUN_STATUSES.map((status) => ghRuns(env, status, 50, names)))).flat();
    let n = 0;
    for (const run of runs) {
      if (!run.id) continue;
      const c = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${run.id}/cancel`, { method: "POST", headers: ghHeaders(env) });
      if (c.ok) n++;
      else if (c.status === 403) return "⚠️ couldn't cancel the CI run (PAT needs Actions: write).";
    }
    return n ? `Canceled ${n} running CI build(s).` : "no running CI build to cancel.";
  } catch {
    return "(CI cancel error)";
  }
}

async function doCancel(env: Env, targetUid: string): Promise<{ message: string }> {
  await env.BUILDS.delete(`cooldown:${targetUid}`);
  const q = await queueStub(env).cancelByTester(targetUid);
  let discarded = 0;
  const dls = await env.BUILDS.list({ prefix: "dl:" });
  for (const k of dls.keys) {
    const d = await env.BUILDS.get<Download>(k.name, "json");
    if (d && d.tester_id === targetUid && (d.status === "queued" || d.status === "building")) {
      d.status = "failed";
      await env.BUILDS.put(k.name, JSON.stringify(d), { expirationTtl: DL_TTL });
      discarded++;
    }
  }
  const ci = await cancelRuns(env);
  return { message: `Reset cooldown for <@${targetUid}>, canceled ${q.canceled} queued action(s), discarded ${discarded} pending build(s). ${ci}` };
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; }
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

interface Run {
  id?: number; name: string; status: string; conclusion: string | null;
  created_at: string; run_started_at?: string; updated_at: string; display_title?: string; path?: string;
}

function runWorkflowType(run: Run): string | undefined {
  return run.path?.match(/\/([^/]+)\.ya?ml$/)?.[1];
}

async function ghRun(env: Env, runId: string): Promise<Run | null> {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${encodeURIComponent(runId)}`, {
    headers: ghHeaders(env),
  });
  if (!r.ok) return null;
  return await r.json() as Run;
}

async function cancelGitHubRunById(env: Env, runId: string): Promise<{ ok: boolean; message: string; run?: Run }> {
  const run = await ghRun(env, runId);
  if (!run) return { ok: false, message: "Matching GitHub Actions run was not found." };
  if (run.status === "completed") {
    return { ok: false, message: `Matching GitHub Actions run is already completed (${run.conclusion || "unknown"}).`, run };
  }

  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: ghHeaders(env),
  });
  if (r.ok) return { ok: true, message: "Sent cancel to the matching GitHub Actions run", run };
  if (r.status === 403) return { ok: false, message: "Couldn't cancel the matching GitHub Actions run (PAT needs Actions: write).", run };
  return { ok: false, message: githubDispatchError("GitHub Actions cancel failed", r.status, await r.text()), run };
}

async function ghRuns(env: Env, status: string, perPage = 20, names: readonly string[] = ["tester-build"]): Promise<Run[]> {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/runs?status=${status}&per_page=${perPage}`, { headers: ghHeaders(env) });
  if (!r.ok) return [];
  const d = (await r.json()) as { workflow_runs: Run[] };
  return d.workflow_runs.filter((x) => names.includes(runWorkflowType(x) || ""));
}

async function ghQueueRuns(env: Env): Promise<Run[]> {
  const batches = await Promise.all(GITHUB_ACTIVE_RUN_STATUSES.map((status) => ghRuns(env, status, 50, QUEUE_WORKFLOW_NAMES)));
  return batches.flat();
}

function queueStatusLabel(status: QueueStatus): string {
  if (status === "queued") return "waiting";
  if (status === "canceling") return "marked for cancel";
  return "working";
}

function queueStatusIcon(status: QueueStatus): string {
  if (status === "queued") return "⏳";
  if (status === "canceling") return "❕";
  return "🔨";
}

function formatQueueItem(item: QueueItem): string {
  const ts = Math.floor(item.created / 1000);
  const runId = item.run_id ?? "?";
  const protectedNote = isCancelProtected(item) ? " - protected" : "";
  return `${queueStatusIcon(item.status)} ${queueStatusLabel(item.status)} - run \`${runId}\` - p${item.priority} - ${item.type} - ${item.display} - <t:${ts}:R>${protectedNote}`;
}

function queueHistoryIcon(status: QueueStatus): string {
  if (status === "done") return "✅";
  if (status === "canceled") return "🚫";
  return "❌";
}

function formatQueueHistoryItem(item: QueueItem): string {
  const ts = Math.floor((item.completed_at || item.dispatched_at || item.created) / 1000);
  const err = item.error ? ` - ${item.error}` : "";
  const runId = item.run_id ?? "?";
  return `${queueHistoryIcon(item.status)} ${item.status} - run \`${runId}\` - p${item.priority} - ${item.type} - ${item.display} - <t:${ts}:R>${err}`;
}

async function listBuilds(env: Env): Promise<string> {
  await queuePump(env);
  const queue = await queueStub(env).list(50);
  const runs = await ghQueueRuns(env);
  if (queue.items.length === 0 && runs.length === 0) return "No queued or running builds.";

  const sections: string[] = [];
  if (queue.items.length > 0) {
    sections.push(`**Priority queue (${queue.total}):**`);
    sections.push(...queue.items.map(formatQueueItem));
  }

  if (runs.length === 0) return sections.join("\n");

  const now = Date.now();
  const lines = runs.map((run) => {
    const startMs = new Date(run.run_started_at || run.created_at).getTime();
    const ranTs = Math.floor(new Date(run.created_at).getTime() / 1000);
    const tag = run.status === "in_progress" ? "🔨 working" : "⏳ waiting";
    return `${tag} - **${run.display_title || run.name || "build"}** - elapsed ${fmtDur(now - startMs)} - ran <t:${ranTs}:R>`;
  });
  sections.push(`**GitHub active (${runs.length}):**`);
  sections.push(...lines);
  return sections.join("\n");
}

async function historyBuilds(env: Env): Promise<string> {
  const queue = await queueStub(env).history(10);
  if (queue.items.length > 0) {
    return `**Recent queued actions:**\n` + queue.items.map(formatQueueHistoryItem).join("\n");
  }

  const runs = (await ghRuns(env, "completed", 12)).slice(0, 10);
  if (runs.length === 0) return "No completed builds yet.";
  const lines = runs.map((run) => {
    const dur = fmtDur(new Date(run.updated_at).getTime() - new Date(run.run_started_at || run.created_at).getTime());
    const icon = run.conclusion === "success" ? "✅" : run.conclusion === "cancelled" ? "🚫" : "❌";
    const ranTs = Math.floor(new Date(run.created_at).getTime() / 1000);
    return `${icon} **${run.display_title || "build"}** — ${run.conclusion} — took ${dur} — <t:${ranTs}:f>`;
  });
  return `**Recent builds:**\n` + lines.join("\n");
}

async function doGenerate(env: Env, uid: string, uname: string, force = false, branch?: string): Promise<{ message: string }> {
  if (branch && !availableBranches(env).has(branch)) {
    const prOk = includePrBranches(env) && (await isOpenPrBranch(env, branch));
    if (!prOk) return { message: `⛔ Unknown branch \`${branch}\`.` };
  }
  if (!force) {
    const allow = (env.GENERATE_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(uid)) {
      return { message: "🚧 Build generation is limited to specific users while it's being tested." };
    }
  }
  const member = await isMember(env, uid);
  if (member !== true) return { message: "⛔ That account isn't in the tester server." };

  const dev = await isDev(env, uid);
  if (!force && !dev && await env.BUILDS.get(`cooldown:${uid}`)) {
    return { message: "⏳ You can only request one build per hour. Try again later." };
  }

  const buildId = uname.toLowerCase().replace(/[^a-z0-9_.-]/g, "") || randId();
  const token = randId();
  await env.BUILDS.put(`build:${buildId}`, JSON.stringify({ tester_id: uid, label: uname, created: Date.now() } as Build));
  await dlPut(env, token, { build_id: buildId, tester_id: uid, status: "queued", created: Date.now() });

  const payload: QueuePayload = { build_id: buildId, token, tester_id: uid, username: uname, branch: branch || "" };
  const queued = await enqueueGithubDispatch(env, {
    type: "tester-build",
    payload,
    priority: force || dev ? 15 : undefined,
    requested_by: uid,
  });
  if (!queued.ok) return { message: "Couldn't queue the build. Ping a dev." };

  if (!force && !dev) await env.BUILDS.put(`cooldown:${uid}`, "1", { expirationTtl: 3600 });
  const branchNote = branch ? ` (branch \`${branch}\`)` : "";
  const pos = queued.position ? ` Position: ${queued.position}.` : "";
  return { message: `Build queued${branchNote}.${pos} You'll get a DM with a one-time download link when it's ready.` };
}

async function doDispatch(
  env: Env,
  workflow: string,
  requestedBy: string,
  branch?: string,
  priority?: number,
): Promise<{ message: string }> {
  if (!isDispatchType(workflow)) return { message: `Unknown workflow \`${workflow}\`.` };
  if (workflow === "tester-build") return { message: "Use /generatefor for tester-build so it has tester metadata." };

  if (isDirectDispatchType(workflow)) {
    const res = await dispatchWorkflowEvent(env, `${workflow}.yml`, branch || "main", directWorkflowInputs(workflow, branch));
    return {
      message: res.ok
        ? `Dispatched ${workflow}${branch ? ` @ ${branch}` : ""}.`
        : `Couldn't dispatch ${workflow}: ${res.error || "GitHub dispatch failed"}`,
    };
  }

  const payload: QueuePayload = {};
  if (branch) {
    payload.branch = branch;
    payload.ref = branch;
  }

  const queued = await enqueueGithubDispatch(env, {
    type: workflow,
    payload,
    priority,
    requested_by: requestedBy,
  });
  if (!queued.ok) return { message: `Couldn't queue ${workflow}: ${queued.item.error || "GitHub dispatch failed"}` };
  const pos = queued.position ? ` Position: ${queued.position}.` : "";
  return { message: `Queued ${workflow}${branch ? ` @ ${branch}` : ""} at priority ${queued.item.priority}.${pos}` };
}

async function doCancelRun(env: Env, runId: string, requestedBy: string): Promise<{ message: string }> {
  const id = runId.trim();
  if (!/^\d+$/.test(id)) return { message: "Run id must be the numeric Worker run id shown by `/queue`." };

  const res = await queueStub(env).cancelByRunId(Number(id), `canceled by <@${requestedBy}>`);
  if (!res.canceled) return { message: `Couldn't cancel Worker run \`${id}\`: ${res.reason || "not found"}` };
  const github = res.github ? ` ${res.github}.` : "";
  const verb = res.item?.status === "canceling" ? "❕ Marked for cancel" : "Canceled";
  return { message: `${verb} Worker run \`${id}\` (${res.item?.type || "run"} - ${res.item?.display || "unknown"}).${github}` };
}

async function editDeferredReply(applicationId: string, token: string, content: string): Promise<void> {
  try {
    const r = await fetch(`${DISCORD}/webhooks/${applicationId}/${token}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) console.error("editDeferredReply failed", r.status, await r.text());
  } catch (e) {
    console.error("editDeferredReply error", e);
  }
}

async function interactions(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text();
  if (!(await verifyDiscordSig(req, body, env))) return new Response("bad signature", { status: 401 });
  const i = JSON.parse(body) as {
    type: number;
    application_id?: string;
    token?: string;
    data?: {
      name?: string;
      options?: { name: string; value?: string | number; focused?: boolean }[];
      resolved?: { users?: Record<string, { username?: string }> };
    };
    member?: { user?: { id?: string; username?: string } };
    user?: { id?: string; username?: string };
  };

  // Some commands (dispatch/generate/generatefor) chain several sequential GitHub API calls
  // (queue pump, run-id resolution with its own retry/backoff, replacement cancellation) that
  // can comfortably exceed Discord's 3s interaction deadline. When that happens Discord shows
  // the interaction as failed even though the work completed successfully server-side. Defer
  // those specific commands (ack immediately, edit the reply once the real work finishes via
  // ctx.waitUntil) so the visible result always matches what actually happened.
  const deferrable = async (run: () => Promise<{ message: string }>): Promise<Response> => {
    if (i.application_id && i.token) {
      const applicationId = i.application_id;
      const token = i.token;
      ctx.waitUntil(
        run()
          .then((res) => editDeferredReply(applicationId, token, res.message))
          .catch((e) => editDeferredReply(applicationId, token, `Internal error: ${e instanceof Error ? e.message : String(e)}`)),
      );
      return json({ type: 5, data: { flags: 64 } });
    }
    // Fallback (shouldn't happen - Discord always sends application_id/token): run inline as before.
    const res = await run();
    return ephem(res.message);
  };

  if (i.type === 1) return json({ type: 1 });

  if (i.type === 4) {
    const invoker = i.member?.user?.id || i.user?.id;
    const focused = (i.data?.options || []).find((o) => o.focused);
    const noChoices = json({ type: 8, data: { choices: [] } });
    const cmd = i.data?.name;
    const devOnlyBranchCmds = new Set(["dispatch", "generatefor"]);
    const branchCmds = new Set(["dispatch", "generate", "generatefor"]);
    if (!invoker || focused?.name !== "branch" || !cmd || !branchCmds.has(cmd)) return noChoices;
    if (devOnlyBranchCmds.has(cmd) && !(await isDev(env, invoker))) return noChoices;
    const typed = String(focused.value ?? "").toLowerCase();
    const branches = cmd === "dispatch" ? await allRepoBranches(env) : (await computeBranchList(env)).branches;
    const choices = branches
      .filter((b) => b.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((b) => ({ name: b, value: b }));
    return json({ type: 8, data: { choices } });
  }

  if (i.type === 2 && i.data?.name === "cancel") {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("⛔ This command is dev-only.");
    const opt = (i.data.options || []).find((o) => o.name === "user");
    const target = (opt?.value as string) || invoker;
    const res = await doCancel(env, target);
    return ephem(res.message);
  }

  if (i.type === 2 && i.data?.name === "cancelrun") {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("This command is dev-only.");
    const runId = (i.data.options || []).find((o) => o.name === "runid")?.value;
    if (runId === undefined) return ephem("Specify the Worker run id from /queue.");
    const res = await doCancelRun(env, String(runId), invoker);
    return ephem(res.message);
  }

  if (i.type === 2 && (i.data?.name === "list" || i.data?.name === "queue" || i.data?.name === "history")) {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("⛔ This command is dev-only.");
    return ephem(i.data.name === "history" ? await historyBuilds(env) : await listBuilds(env));
  }

  if (i.type === 2 && i.data?.name === "generatefor") {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("⛔ This command is dev-only.");
    const opt = (i.data.options || []).find((o) => o.name === "user");
    const target = opt?.value === undefined ? "" : String(opt.value);
    if (!target) return ephem("Specify a user to generate for.");
    const targetName = i.data.resolved?.users?.[target]?.username || target;
    const branch = (i.data.options || []).find((o) => o.name === "branch")?.value as string | undefined;
    return await deferrable(async () => {
      const res = await doGenerate(env, target, targetName, true, branch);
      return { message: `🛠️ (for <@${target}>) ${res.message}` };
    });
  }

  if (i.type === 2 && i.data?.name === "dispatch") {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("This command is dev-only.");
    const workflow = (i.data.options || []).find((o) => o.name === "workflow")?.value as string | undefined;
    const branch = (i.data.options || []).find((o) => o.name === "branch")?.value as string | undefined;
    const priorityRaw = (i.data.options || []).find((o) => o.name === "priority")?.value as number | undefined;
    if (!workflow) return ephem("Specify a workflow.");
    return await deferrable(() => doDispatch(env, workflow, invoker, branch, priorityRaw));
  }

  if (i.type === 2 && i.data?.name === "generate") {
    if (env.GENERATE_ENABLED === "false") {
      return ephem("🚧 Build generation is currently turned off. Check back later.");
    }
    const uid = i.member?.user?.id || i.user?.id;
    const uname = i.member?.user?.username || i.user?.username || "?";
    if (!uid) return ephem("Couldn't read your Discord account.");
    const branch = (i.data.options || []).find((o) => o.name === "branch")?.value as string | undefined;
    return await deferrable(() => doGenerate(env, uid, uname, false, branch));
  }

  return ephem("Unknown command.");
}

async function agentComplete(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { token?: string; tester_id?: string; build_id?: string; queue_id?: string };
  if (!b.token || !b.tester_id || !b.build_id) return json({ error: "token, tester_id, build_id required" }, 400);
  const key = `builds/${b.build_id}.zip`;
  await dlPut(env, b.token, { build_id: b.build_id, tester_id: b.tester_id, status: "ready", key, created: Date.now() });
  const link = `${env.PUBLIC_BASE_URL}/download/${b.token}`;
  await dmUser(
    env, b.tester_id,
    `✅ Your tester build is ready!\nDownload (sign in with Discord — one-time link): ${link}\n\n` +
    `Tied to **your** account; do not share. The link expires after 6 hours if unused. ` +
    `After your first completed download, it stays available for 30 minutes in case you need to retry, then auto-deletes.`,
  );
  if (b.queue_id) await queueStub(env).complete(b.queue_id, undefined, true);
  else await queueStub(env).completeTesterBuild(b.token, true);
  return json({ ok: true });
}

async function mentionGenerate(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  if (env.MENTION_ENABLED !== "true") return json({ ignore: true });
  const b = (await req.json().catch(() => ({}))) as { user_id?: string; username?: string };
  if (!b.user_id) return json({ error: "user_id required" }, 400);
  const res = await doGenerate(env, b.user_id, b.username || "?");
  return json({ message: res.message });
}

async function downloadStart(token: string, env: Env): Promise<Response> {
  const d = await dlGet(env, token);
  if (!d) return page("This download link is invalid or expired.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page("This build's download buffer expired. Run /generate again for a new copy.", false, 410);
  }
  if (d.status === "downloaded") d.status = "ready";
  if (d.status !== "ready") return page("Your build isn't ready yet — check back in a moment.", false, 425);
  const state = randState();
  const sess: Session = { build_id: d.build_id, created: Date.now(), status: "pending", kind: "download", token };
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: ttl(env) });
  return Response.redirect(authorizeUrl(env, state), 302);
}

async function downloadAuth(env: Env, state: string, sess: Session, user: { id: string; username?: string }, ctx: ExecutionContext): Promise<Response> {
  const d = sess.token ? await dlGet(env, sess.token) : null;
  if (!d) return page("This download link expired.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page("This build's download buffer expired.", false, 410);
  }
  if (d.status === "downloaded") d.status = "ready";
  const member = await isMember(env, user.id);
  const allowed = member === true && (user.id === d.tester_id || await isDev(env, user.id));
  if (!allowed) {
    const reason = member ? "this build isn't assigned to your account" : "you're not in the tester server";
    ctx.waitUntil(alertDenied(env, d.build_id, user, `download — ${reason}`));
    return page(`Download denied — ${reason}.`, false, 403);
  }
  sess.status = "done"; sess.authorized = true; sess.user_id = user.id;
  await env.SESSIONS.put(state, JSON.stringify(sess), { expirationTtl: ttl(env) });
  return downloadStartedPage(`${env.PUBLIC_BASE_URL}/download-file?state=${state}`);
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

async function updateAuth(env: Env, state: string, sess: Session, user: { id: string; username?: string }, ctx: ExecutionContext): Promise<Response> {
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

function downloadStartedPage(fileUrl: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Antileak</title>
<style>body{background:#2b2d31;color:#fff;font-family:system-ui,sans-serif;display:flex;
height:100vh;align-items:center;justify-content:center;margin:0}.c{text-align:center;padding:2rem}
.i{font-size:3rem}h1{color:#3ba55d;margin:.4rem 0}p{color:#b5bac1}</style></head>
<body><div class="c"><div class="i">✅</div><h1>Download started</h1>
<p>Your build is downloading. This tab will close itself in a minute — or you can close it now.</p></div>
<iframe style="display:none" src="${fileUrl}"></iframe>
${autoCloseScript(2000)}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function downloadFile(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const state = url.searchParams.get("state") || "";
  const raw = await env.SESSIONS.get(state);
  if (!raw) return page("Download session expired — open the link again.", false, 400);
  const sess = JSON.parse(raw) as Session;

  if (sess.kind === "update") {
    if (!sess.authorized || !sess.update_key) return page("Not authorized.", false, 403);
    const filename = sess.update_key.split("/").pop() || "update.bin";
    const response = await r2DownloadResponse(req, env.BUILDS_R2, sess.update_key, "application/octet-stream", filename);
    return response || page("Update file not found (already cleaned up).", false, 404);
  }

  if (sess.kind !== "download" || !sess.authorized || !sess.token) return page("Not authorized.", false, 403);
  const d = await dlGet(env, sess.token);
  if (!d || !d.key) return page("Build file is gone.", false, 404);
  if (d.status === "used" || downloadBufferExpired(d)) {
    return page("This build's download buffer expired.", false, 410);
  }
  if (d.status === "downloaded") d.status = "ready";
  const downloadedAt = d.downloaded_at || Date.now();
  d.status = "downloaded";
  d.downloaded_at = downloadedAt;
  d.delete_after = d.delete_after || downloadedAt + DOWNLOADED_DELETE_BUFFER_MS;
  await dlPut(env, sess.token, d);

  const response = await r2DownloadResponse(req, env.BUILDS_R2, d.key, "application/zip", `build-${d.build_id}.zip`);
  return response || page("Build file not found (already cleaned up).", false, 404);
}

async function agentFail(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { tester_id?: string; build_id?: string; token?: string; queue_id?: string; error?: string };
  if (b.token) {
    const d = await dlGet(env, b.token);
    if (d) { d.status = "failed"; await dlPut(env, b.token, d); }
    if (b.queue_id) await queueStub(env).complete(b.queue_id, undefined, false, b.error || "runner reported failure");
    else await queueStub(env).completeTesterBuild(b.token, false, b.error || "runner reported failure");
  }
  else await queuePump(env);
  if (b.tester_id) await dmUser(env, b.tester_id, "⛔ Build failed! Ping a dev!");
  return json({ ok: true });
}

async function queueComplete(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { queue_id?: string; ok?: boolean; error?: string };
  if (!b.queue_id) return json({ error: "queue_id required" }, 400);
  const res = await queueStub(env).complete(b.queue_id, undefined, b.ok !== false, b.error || "");
  return json({ ok: true, ...res });
}

async function queueProtect(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { queue_id?: string };
  if (!b.queue_id) return json({ error: "queue_id required" }, 400);
  const res = await queueStub(env).protectFromCancel(b.queue_id);
  return json(res, res.ok ? 200 : 404);
}

async function createSession(req: Request, env: Env): Promise<Response> {
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

async function createUpdateSession(req: Request, env: Env): Promise<Response> {
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

async function createUpdateSessionFast(req: Request, env: Env): Promise<Response> {
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

async function callback(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
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

async function logEvent(env: Env, rec: Record<string, unknown>): Promise<void> {
  const full = { ts: Date.now(), ...rec };
  console.log("VERIFY", JSON.stringify(full));
  await env.BUILDS.put(`log:${Date.now()}-${randState().slice(0, 6)}`, JSON.stringify(full),
    { expirationTtl: 60 * 60 * 24 * 90 });
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

async function latestVersion(url: URL, env: Env): Promise<Response> {
  const requested = (url.searchParams.get("branch") || "main").trim();
  if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(requested)) return json({ error: "bad branch" }, 400);
  const branch = await resolveTrackingBranch(env, requested);
  const obj = await env.BUILDS_R2.get(`base/${branch}/latest.json`);
  if (!obj) return json({ error: "no base build for branch" }, 404);
  const data = (await obj.json()) as { branch: string; sha: string; prev_sha: string | null };
  return json({ branch: data.branch, sha: data.sha });
}

async function result(url: URL, env: Env): Promise<Response> {
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

async function computeBranchList(env: Env): Promise<{ testable: string; branches: string[] }> {
  const testable = testableBranch(env);
  let branches = [testable, ...availableBranches(env)];
  if (includePrBranches(env)) {
    branches = branches.concat(await openPrBranches(env));
  }
  branches = branches.filter((b, i, arr) => arr.indexOf(b) === i);
  return { testable, branches };
}

async function listBranches(env: Env): Promise<Response> {
  return json(await computeBranchList(env));
}

async function registerBuild(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { build_id?: string; tester_id?: string; label?: string };
  const buildId = (b.build_id || "").trim();
  const testerId = (b.tester_id || "").trim();
  if (!buildId || !testerId) return json({ error: "build_id and tester_id required" }, 400);
  const rec: Build = { tester_id: testerId, label: b.label || "", created: Date.now() };
  await env.BUILDS.put(`build:${buildId}`, JSON.stringify(rec));
  return json({ ok: true, build_id: buildId, ...rec });
}

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

async function adminQueue(req: Request, url: URL, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const pump = await queuePump(env);
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10));
  const historyLimit = Math.min(25, parseInt(url.searchParams.get("history") || "10", 10));
  const [queue, history, active_runs] = await Promise.all([
    queueStub(env).list(limit),
    queueStub(env).history(historyLimit),
    ghQueueRuns(env),
  ]);
  return json({ ...queue, history: history.items, active_runs, pump });
}

async function adminEnqueue(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as {
    type?: string; priority?: number; requested_by?: string; payload?: QueuePayload;
    ref?: string; branch?: string; sha?: string; wipe_r2_base?: boolean;
  };
  if (!b.type || !isQueueDispatchType(b.type)) return json({ error: "type must be tester-build, base-build, compile, or clear-gm-cache" }, 400);

  const payload: QueuePayload = { ...(b.payload || {}) };
  if (b.ref !== undefined) payload.ref = b.ref;
  if (b.branch !== undefined) payload.branch = b.branch;
  if (b.sha !== undefined) payload.sha = b.sha;
  if (b.wipe_r2_base !== undefined) payload.wipe_r2_base = b.wipe_r2_base;

  if (b.type === "tester-build") {
    return json({ error: "tester-build should be queued through /generate or /generatefor" }, 400);
  }

  const queued = await enqueueGithubDispatch(env, {
    type: b.type,
    payload,
    priority: b.priority,
    requested_by: b.requested_by,
  });
  return json(queued, queued.ok ? 200 : 500);
}

async function adminCancelBranch(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { branch?: string; reason?: string; types?: string[] };
  const branch = normalizeQueueBranch(b.branch || "");
  if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(branch)) return json({ error: "bad branch" }, 400);

  let types: QueueDispatchType[] | undefined;
  if (b.types !== undefined) {
    if (!Array.isArray(b.types)) return json({ error: "types must be an array" }, 400);
    types = [];
    for (const type of b.types) {
      if (!isQueueDispatchType(type)) return json({ error: `bad queue type ${type}` }, 400);
      types.push(type);
    }
  }

  const reason = (b.reason || `branch ${branch} deleted`).trim().slice(0, 200);
  const result = await queueStub(env).cancelByBranch(branch, reason, types);
  await logEvent(env, {
    kind: "branch_queue_cancel",
    branch,
    types,
    canceled: result.canceled,
    runs: result.items.map((item) => ({ id: item.id, run_id: item.run_id, type: item.type, display: item.display })),
    skipped_protected: result.skipped_protected.map((item) => ({ id: item.id, run_id: item.run_id, type: item.type, display: item.display })),
    github: result.github,
  });
  return json({ ok: true, branch, ...result });
}

function normalizeChangedFile(file: unknown): string {
  return String(file || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function isMarkdownPath(file: string): boolean {
  return file.toLowerCase().endsWith(".md");
}

function isIgnoredForBaseBuild(file: string): boolean {
  if (file.startsWith("antileak/")) return false;
  if (file === "tools/antileak" || file.startsWith("tools/antileak/")) return false;
  if (file === ".github/workflows/base-build.yml") return false;
  if (file === "datafiles/lang/english.txt") return true;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith("tools/")) return true;
  return isMarkdownPath(file);
}

function isIgnoredForCompile(file: string): boolean {
  if (file.startsWith("antileak/")) return false;
  if (file === "tools/antileak" || file.startsWith("tools/antileak/")) return false;
  if (file === ".github/workflows/base-build.yml") return false;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith("tools/")) return true;
  return isMarkdownPath(file);
}

function hasRelevantChange(files: string[], ignored: (file: string) => boolean): boolean {
  return files.length === 0 || files.some((file) => !ignored(file));
}

async function isBaseBuildBranch(env: Env, branch: string): Promise<boolean> {
  if (branch === testableBranch(env)) return true;
  if (availableBranches(env).has(branch)) return true;
  return includePrBranches(env) && await isOpenPrBranch(env, branch);
}

async function baseBuildCacheMatches(env: Env, branch: string, sha: string): Promise<boolean> {
  const targetSha = shortSha(sha);
  if (!targetSha) return false;
  const latestObj = await env.BUILDS_R2.get(`base/${branch}/latest.json`);
  if (!latestObj) return false;
  const latest = (await latestObj.json().catch(() => null)) as { sha?: string } | null;
  if (!latest?.sha || shortSha(latest.sha) !== targetSha) return false;
  return !!(await env.BUILDS_R2.head(`base/${branch}/${targetSha}.zip`));
}

async function adminPushSignal(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as {
    branch?: string; sha?: string; before?: string; actor?: string; files?: unknown[];
  };
  const branch = (b.branch || "").trim();
  const sha = (b.sha || "").trim();
  if (!/^[a-zA-Z0-9_.\/-]{1,100}$/.test(branch)) return json({ error: "bad branch" }, 400);
  if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) return json({ error: "bad sha" }, 400);

  const files = (Array.isArray(b.files) ? b.files : [])
    .map(normalizeChangedFile)
    .filter(Boolean)
    .slice(0, 200);
  const changedFiles = files.slice(0, 100).join("\n");
  const payload: QueuePayload = { ref: branch, branch, sha, changed_files: changedFiles };
  const queued: QueueEnqueueResult[] = [];
  const skipped: string[] = [];
  const baseBranch = await isBaseBuildBranch(env, branch);

  if (baseBranch) {
    if (await baseBuildCacheMatches(env, branch, sha)) {
      skipped.push("base-build: base cache already available");
    } else if (hasRelevantChange(files, isIgnoredForBaseBuild)) {
      queued.push(await enqueueGithubDispatch(env, {
        type: "base-build",
        payload,
        priority: await resolveQueuePriority(env, "base-build", payload),
        requested_by: b.actor,
      }));
    } else {
      skipped.push("base-build: only ignored paths changed");
    }
  } else {
    skipped.push("base-build: branch is not buildable");
  }

  if (!baseBranch) {
    if (hasRelevantChange(files, isIgnoredForCompile)) {
      queued.push(await enqueueGithubDispatch(env, {
        type: "compile",
        payload,
        priority: await resolveQueuePriority(env, "compile", payload),
        requested_by: b.actor,
      }));
    } else {
      skipped.push("compile: only ignored paths changed");
    }
  } else {
    skipped.push("compile: base-build covers this branch");
  }

  await logEvent(env, {
    kind: "push_signal",
    branch,
    sha,
    before: b.before,
    actor: b.actor,
    files,
    queued: queued.map((q) => ({ id: q.item.id, type: q.item.type, status: q.item.status, priority: q.item.priority })),
    skipped,
  });

  return json({ ok: true, branch, sha, files, queued, skipped });
}

function esc(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

function autoCloseScript(delayMs: number): string {
  const delay = Math.max(0, Math.trunc(delayMs));
  return `<script>
(function(){
  function attemptClose(){
    try { window.open('', '_self'); } catch (e) {}
    try { window.close(); } catch (e) {}
  }
  function startClose(){
    attemptClose();
    var tries = 0;
    var timer = setInterval(function(){
      attemptClose();
      tries += 1;
      if (tries >= 10) clearInterval(timer);
    }, 500);
  }
  if (document.readyState === 'complete') {
    setTimeout(startClose, ${delay});
  } else {
    window.addEventListener('load', function(){ setTimeout(startClose, ${delay}); }, { once: true });
    setTimeout(startClose, ${delay + 3000});
  }
})();
</script>`;
}

function page(msg: string, ok: boolean, status = 200): Response {
  const color = ok ? "#3ba55d" : "#ed4245";
  const icon = ok ? "✅" : "⛔";
  const title = ok ? "Verified" : "Denied";
  const hint = ok ? "<p>You can close this tab and return to the game.</p>" : "";
  const closer = ok ? autoCloseScript(800) : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Antileak</title>
<style>body{background:#2b2d31;color:#fff;font-family:system-ui,sans-serif;display:flex;
height:100vh;align-items:center;justify-content:center;margin:0}.c{text-align:center;padding:2rem}
.i{font-size:3rem}h1{color:${color};margin:.4rem 0}p{color:#b5bac1}</style></head>
<body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${msg}</p>${hint}</div>${closer}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
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

    const now = Date.now();
    const stuckBefore = now - 30 * 60 * 1000;
    const protectedKeys = new Set<string>();
    const dls = await env.BUILDS.list({ prefix: "dl:" });
    for (const k of dls.keys) {
      const d = await env.BUILDS.get<Download>(k.name, "json");
      if (d && d.status === "building" && d.created < stuckBefore) {
        d.status = "failed";
        await env.BUILDS.put(k.name, JSON.stringify(d), { expirationTtl: DL_TTL });
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
  },
};
