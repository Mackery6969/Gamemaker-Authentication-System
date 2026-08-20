// Low-level GitHub REST API helpers shared by the queue/CI-dispatch system
// (queue.ts) and the update-checking system (updates.ts, for PR-branch
// tracking). Nothing here is queue-specific.
import type { Env } from "./types";

export const GH_API_VERSION = "2026-03-10";

export function ghHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GH_API_VERSION,
    "User-Agent": "antileak-worker",
  };
}

export function githubDispatchError(prefix: string, status: number, text: string): string {
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

export type QueuePayload = Record<string, string | number | boolean | null | undefined>;

export async function dispatchRepositoryEvent(env: Env, eventType: string, clientPayload: QueuePayload): Promise<{ ok: boolean; error?: string }> {
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

export async function dispatchWorkflowEvent(
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

export async function isOpenPrBranch(env: Env, branch: string): Promise<boolean> {
  const owner = env.GITHUB_REPO.split("/")[0];
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&per_page=1`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return false;
  const prs = (await r.json()) as unknown[];
  return prs.length > 0;
}

export async function openPrBranches(env: Env): Promise<string[]> {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&per_page=100`,
    { headers: ghHeaders(env) },
  );
  if (!r.ok) return [];
  const prs = (await r.json()) as { head: { ref: string } }[];
  return prs.map((pr) => pr.head.ref);
}

export async function allRepoBranches(env: Env): Promise<string[]> {
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
