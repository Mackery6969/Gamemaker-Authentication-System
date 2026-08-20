// ============================================================================
// The CI/build-queue system - OPTIONAL. Everything in this file is only
// needed if you want Discord-driven CI automation (tester-build/base-build/
// compile/clear-gm-cache dispatch, the priority queue, GitHub Actions run
// tracking). If you just want Discord-gated auth + manual downloads, you can
// delete this file entirely along with:
//   - interactions.ts (all its slash commands are queue commands)
//   - index.ts's imports from and route registrations for both of the above
//   - the BUILD_QUEUE durable_objects binding in wrangler.toml
//   - the `queuePump(env)` call in index.ts's scheduled() handler
// updates.ts still expects `base/<branch>/...` objects to exist in R2 (see
// its file header) - without this queue system driving base-build.yml,
// you'd need some other way to populate those, or skip wiring up updates.
// ============================================================================
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { json, safeEqual, randId, fmtDur, logEvent } from "./util";
import { dmUser, postEmbedToChannel, isDev, isMember, type DiscordEmbed, EMBED_COLOR_SUCCESS, EMBED_COLOR_FAILURE } from "./discord";
import { ghHeaders, githubDispatchError, dispatchRepositoryEvent, dispatchWorkflowEvent, isOpenPrBranch, type QueuePayload } from "./github";
import type { Build } from "./builds";
import { dlGet, dlPut, type Download } from "./downloads";
import { testableBranch, includePrBranches, availableBranches } from "./updates";

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

export type QueueDispatchType = "tester-build" | "base-build" | "compile" | "clear-gm-cache";
export type DirectDispatchType = "sync-pr-with-main";
export type DispatchType = QueueDispatchType | DirectDispatchType;
export type QueueStatus = "queued" | "dispatching" | "dispatched" | "canceling" | "done" | "failed" | "canceled";

export interface QueueItemInput {
  id?: string;
  type: QueueDispatchType;
  priority?: number;
  payload?: QueuePayload;
  requested_by?: string;
  display?: string;
  dedupe_key?: string;
}

export interface QueueItem {
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

export interface QueuePumpResult {
  dispatched: boolean;
  reason: string;
  item?: QueueItem;
  active_runs?: number;
  blocked_reason?: string;
}

export interface QueueEnqueueResult {
  ok: boolean;
  item: QueueItem;
  position: number | null;
  pump: QueuePumpResult;
}

export interface QueueListResult {
  items: QueueItem[];
  total: number;
}

export interface QueueHistoryResult {
  items: QueueItem[];
}

export interface QueueCancelByBranchResult {
  canceled: number;
  items: QueueItem[];
  skipped_protected: QueueItem[];
  github: string[];
}

function queuePayloadString(payload: QueuePayload, key: string): string {
  const v = payload[key];
  if (v === undefined || v === null) return "";
  return String(v);
}

export function normalizeQueueBranch(branch: string): string {
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

export async function queuePump(env: Env): Promise<QueuePumpResult> {
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

export function isQueueDispatchType(type: string): type is QueueDispatchType {
  return type === "tester-build" || type === "base-build" || type === "compile" || type === "clear-gm-cache";
}

function isDirectDispatchType(type: string): type is DirectDispatchType {
  return type === "sync-pr-with-main";
}

export function isDispatchType(type: string): type is DispatchType {
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

interface Run {
  id?: number; name: string; status: string; conclusion: string | null;
  created_at: string; run_started_at?: string; updated_at: string; display_title?: string; path?: string;
}

function runWorkflowType(run: Run): string | undefined {
  return run.path?.match(/\/([^/]+)\.ya?ml$/)?.[1];
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
         priority ASC, created ASC
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

export async function doCancel(env: Env, targetUid: string): Promise<{ message: string }> {
  await env.BUILDS.delete(`cooldown:${targetUid}`);
  const q = await queueStub(env).cancelByTester(targetUid);
  let discarded = 0;
  const dls = await env.BUILDS.list({ prefix: "dl:" });
  for (const k of dls.keys) {
    const d = await env.BUILDS.get<Download>(k.name, "json");
    if (d && d.tester_id === targetUid && (d.status === "queued" || d.status === "building")) {
      d.status = "failed";
      await env.BUILDS.put(k.name, JSON.stringify(d), { expirationTtl: 60 * 60 * 6 });
      discarded++;
    }
  }
  const ci = await cancelRuns(env);
  return { message: `Reset cooldown for <@${targetUid}>, canceled ${q.canceled} queued action(s), discarded ${discarded} pending build(s). ${ci}` };
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

export async function listBuilds(env: Env): Promise<string> {
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

export async function historyBuilds(env: Env): Promise<string> {
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

export async function doGenerate(env: Env, uid: string, uname: string, force = false, branch?: string): Promise<{ message: string }> {
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

export async function doDispatch(
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

export async function doCancelRun(env: Env, runId: string, requestedBy: string): Promise<{ message: string }> {
  const id = runId.trim();
  if (!/^\d+$/.test(id)) return { message: "Run id must be the numeric Worker run id shown by `/queue`." };

  const res = await queueStub(env).cancelByRunId(Number(id), `canceled by <@${requestedBy}>`);
  if (!res.canceled) return { message: `Couldn't cancel Worker run \`${id}\`: ${res.reason || "not found"}` };
  const github = res.github ? ` ${res.github}.` : "";
  const verb = res.item?.status === "canceling" ? "❕ Marked for cancel" : "Canceled";
  return { message: `${verb} Worker run \`${id}\` (${res.item?.type || "run"} - ${res.item?.display || "unknown"}).${github}` };
}

export async function agentComplete(req: Request, env: Env): Promise<Response> {
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

export async function mentionGenerate(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  if (env.MENTION_ENABLED !== "true") return json({ ignore: true });
  const b = (await req.json().catch(() => ({}))) as { user_id?: string; username?: string };
  if (!b.user_id) return json({ error: "user_id required" }, 400);
  const res = await doGenerate(env, b.user_id, b.username || "?");
  return json({ message: res.message });
}

export async function agentFail(req: Request, env: Env): Promise<Response> {
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

export async function queueComplete(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { queue_id?: string; ok?: boolean; error?: string };
  if (!b.queue_id) return json({ error: "queue_id required" }, 400);
  const res = await queueStub(env).complete(b.queue_id, undefined, b.ok !== false, b.error || "");
  return json({ ok: true, ...res });
}

export async function queueProtect(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("x-admin-key") || "", env.ADMIN_API_KEY)) return json({ error: "bad admin key" }, 401);
  const b = (await req.json().catch(() => ({}))) as { queue_id?: string };
  if (!b.queue_id) return json({ error: "queue_id required" }, 400);
  const res = await queueStub(env).protectFromCancel(b.queue_id);
  return json(res, res.ok ? 200 : 404);
}

export async function adminQueue(req: Request, url: URL, env: Env): Promise<Response> {
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

export async function adminEnqueue(req: Request, env: Env): Promise<Response> {
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

export async function adminCancelBranch(req: Request, env: Env): Promise<Response> {
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
  if (file === "dllgenerator" || file.startsWith("dllgenerator/")) return false;
  if (file === ".github/workflows/base-build.yml") return false;
  if (file === "datafiles/lang/english.txt") return true;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith("game-ci/")) return true;
  return isMarkdownPath(file);
}

function isIgnoredForCompile(file: string): boolean {
  if (file.startsWith("antileak/")) return false;
  if (file === "dllgenerator" || file.startsWith("dllgenerator/")) return false;
  if (file === ".github/workflows/base-build.yml") return false;
  if (file.startsWith(".github/workflows/")) return true;
  if (file.startsWith("game-ci/")) return true;
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

export async function adminPushSignal(req: Request, env: Env): Promise<Response> {
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
