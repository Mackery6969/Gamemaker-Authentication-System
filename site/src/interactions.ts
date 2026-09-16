// The Discord slash-command HTTP endpoint - signature verification, command
// routing, autocomplete, and the "defer + edit later" dance for commands
// that can run long enough to blow Discord's 3s interaction deadline.
// Every command implemented here is queue.ts-backed, so this whole file is
// part of the optional CI/build-queue system (see queue.ts's header) - if
// you remove queue.ts, remove this file and its route registration too.
import type { Env } from "./types";
import { DISCORD, verifyDiscordSig, ephem, isDev } from "./discord";
import { allRepoBranches } from "./github";
import { computeBranchList } from "./updates";
import { doCancel, doCancelBuild, doCancelRun, doDispatch, doGenerate, listBuilds, historyBuilds } from "./queue";

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

export async function interactions(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return new Response(JSON.stringify({ type: 5, data: { flags: 64 } }), { headers: { "content-type": "application/json" } });
    }
    // Fallback (shouldn't happen - Discord always sends application_id/token): run inline as before.
    const res = await run();
    return ephem(res.message);
  };

  if (i.type === 1) return new Response(JSON.stringify({ type: 1 }), { headers: { "content-type": "application/json" } });

  if (i.type === 4) {
    const invoker = i.member?.user?.id || i.user?.id;
    const focused = (i.data?.options || []).find((o) => o.focused);
    const noChoices = new Response(JSON.stringify({ type: 8, data: { choices: [] } }), { headers: { "content-type": "application/json" } });
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
    return new Response(JSON.stringify({ type: 8, data: { choices } }), { headers: { "content-type": "application/json" } });
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

  if (i.type === 2 && i.data?.name === "cancel-build") {
    const invoker = i.member?.user?.id || i.user?.id;
    if (!invoker || !(await isDev(env, invoker))) return ephem("This command is dev-only.");
    const buildId = (i.data.options || []).find((o) => o.name === "buildid")?.value;
    if (buildId === undefined) return ephem("Specify the build id from /queue.");
    return await deferrable(() => doCancelBuild(env, String(buildId), invoker));
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
