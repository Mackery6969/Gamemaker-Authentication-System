// The "which tester is this build_id for" record, plus signed device tokens
// that let a returning tester skip the Discord login browser round-trip.
// Deliberately separate from auth.ts (which needs this) and updates.ts
// (which also needs this) so those two don't have to import each other.
import type { Env } from "./types";
import { sign, safeEqual } from "./util";
import { deriveBuildSig, toHexString } from "./antileakid";
import { isMember, isDev } from "./discord";

export interface Build {
  tester_id: string;
  label: string;
  created: number;
}
export interface VerifyFile {
  path: string;
  sha256: string;
}

export function getBuild(env: Env, id: string) {
  return env.BUILDS.get<Build>(`build:${id}`, "json");
}

const DEVICE_TOKEN_TTL_MS = 60 * 60 * 24 * 1000;

export async function signDeviceToken(
  env: Env,
  testerId: string,
): Promise<string> {
  const payload = btoa(
    JSON.stringify({
      tester_id: testerId,
      exp: Date.now() + DEVICE_TOKEN_TTL_MS,
    }),
  );
  return `${payload}.${await sign(env.SIGNING_SECRET, payload)}`;
}

export async function verifyDeviceToken(
  env: Env,
  token: string,
): Promise<{ tester_id: string } | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await sign(env.SIGNING_SECRET, payload))) return null;
  try {
    const data = JSON.parse(atob(payload)) as {
      tester_id?: string;
      exp?: number;
    };
    if (!data.tester_id || !data.exp || data.exp < Date.now()) return null;
    return { tester_id: data.tester_id };
  } catch {
    return null;
  }
}

export async function tokenAuthorizedFor(
  env: Env,
  decoded: { tester_id: string } | null,
  build: Build,
): Promise<boolean> {
  if (!decoded) return false;
  if (decoded.tester_id === build.tester_id)
    return (await isMember(env, decoded.tester_id)) === true;
  return isDev(env, decoded.tester_id);
}

export function requireBuildSig(env: Env): boolean {
  return (env.REQUIRE_BUILD_SIG || "").toLowerCase() === "true";
}

export async function checkBuildSig(
  env: Env,
  buildId: string,
  provided?: string,
): Promise<{ ok: boolean; reason: string }> {
  const given = (provided || "").trim().toLowerCase();
  if (!given) {
    if (requireBuildSig(env))
      return { ok: false, reason: "no signature supplied" };
    return { ok: true, reason: "unsigned build (REQUIRE_BUILD_SIG is off)" };
  }
  const expected = toHexString(
    await deriveBuildSig(env.SIGNING_SECRET, buildId),
  );
  if (!safeEqual(given, expected))
    return { ok: false, reason: "signature does not match build_id" };
  return { ok: true, reason: "signature ok" };
}
