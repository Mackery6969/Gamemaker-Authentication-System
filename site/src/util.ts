// Generic helpers with no domain-specific knowledge - safe to reuse from
// any module without creating dependency-direction problems.
import type { Env } from "./types";

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json" },
  });

export const ttl = (env: Env) => Math.max(60, parseInt(env.SESSION_TTL || "600", 10));
export const updateTtl = (env: Env) => Math.max(ttl(env), 60 * 60);

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sign(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

export function randState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

export function esc(s: string) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; }
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function autoCloseScript(delayMs: number): string {
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

export function page(msg: string, ok: boolean, status = 200): Response {
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

type ParsedByteRange = { offset: number; length: number; end: number };

export function parseByteRange(header: string | null, size: number): ParsedByteRange | "invalid" | null {
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

export async function r2DownloadResponse(
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

export async function logEvent(env: Env, rec: Record<string, unknown>): Promise<void> {
  const full = { ts: Date.now(), ...rec };
  console.log("VERIFY", JSON.stringify(full));
  await env.BUILDS.put(`log:${Date.now()}-${randState().slice(0, 6)}`, JSON.stringify(full),
    { expirationTtl: 60 * 60 * 24 * 90 });
}
