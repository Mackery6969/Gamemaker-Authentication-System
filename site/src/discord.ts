// Discord API helpers - OAuth URL building, interaction signature
// verification, membership/dev-role checks, and sending messages/DMs/embeds.
import type { Env } from "./types";

export const DISCORD = "https://discord.com/api/v10";
// Discord asks for a descriptive User-Agent identifying your app; point this at your own project/repo URL.
export const UA = "DiscordBot (https://github.com/your-org/your-repo, 1.0)";

export const devIds = (env: Env) =>
  new Set((env.DEV_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
export const devRoleIds = (env: Env) =>
  new Set((env.DEV_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));

export function authorizeUrl(env: Env, state: string): string {
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: "code", scope: "identify", state,
  });
  return `${DISCORD}/oauth2/authorize?${q}`;
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

export async function verifyDiscordSig(req: Request, body: string, env: Env): Promise<boolean> {
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

export const ephem = (content: string) =>
  new Response(JSON.stringify({ type: 4, data: { content, flags: 64 } }), {
    headers: { "content-type": "application/json" },
  });

export async function isMember(env: Env, uid: string): Promise<boolean | null> {
  const r = await fetch(`${DISCORD}/guilds/${env.TESTER_GUILD_ID}/members/${uid}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "User-Agent": UA },
  });
  if (r.status === 200) return true;
  if (r.status === 404) return false;
  console.warn(`membership check error ${r.status} for ${uid}`);
  return null;
}

export async function isDev(env: Env, uid: string): Promise<boolean> {
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

export async function dmUser(env: Env, userId: string, content: string): Promise<void> {
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

export async function postToChannel(env: Env, channelId: string, content: string): Promise<void> {
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

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

export async function postEmbedToChannel(env: Env, channelId: string, embed: DiscordEmbed): Promise<void> {
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

export const EMBED_COLOR_SUCCESS = 0x2ecc71;
export const EMBED_COLOR_FAILURE = 0xe74c3c;

export async function alertDenied(env: Env, buildId: string, user: { id: string; username?: string }, reason: string): Promise<void> {
  await postToChannel(
    env, env.ALERT_CHANNEL_ID,
    `⛔ **Auth denied** — **${user.username ?? user.id}** (<@${user.id}>, \`${user.id}\`) ` +
    `tried build \`${buildId}\` but was denied (${reason}).`,
  );
}

export async function notifyBuildReady(env: Env, testerId: string, token: string): Promise<void> {
  const link = `${env.PUBLIC_BASE_URL}/download/${token}`;
  await dmUser(
    env, testerId,
    `✅ Your tester build is ready!\nDownload (sign in with Discord — one-time link): ${link}\n\n` +
    `Tied to **your** account; do not share. The link expires after 6 hours if unused. ` +
    `After your first completed download, it stays available for 30 minutes in case you need to retry, then auto-deletes.`,
  );
}

export async function alertMintFailed(env: Env, buildId: string, baseKey: string, reason: string): Promise<void> {
  await postToChannel(
    env, env.ALERT_CHANNEL_ID,
    `🧩 **Mint failed** — couldn't assemble build \`${buildId}\` from \`${baseKey}\` (${reason}). ` +
    `Falling back to the runner package if one exists.`,
  );
}

export async function alertUpdateFailed(env: Env, buildId: string, user: { id: string; username?: string }, reason: string): Promise<void> {
  await postToChannel(
    env, env.ALERT_CHANNEL_ID,
    `⚠️ **Update failed** — **${user.username ?? user.id}** (<@${user.id}>, \`${user.id}\`) ` +
    `build \`${buildId}\` (${reason}).`,
  );
}
