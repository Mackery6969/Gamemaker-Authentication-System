/** Must match ID_SLOT's initialiser in antileak_id.c. */
const SLOT_MAGIC = new Uint8Array([
  0x9e, 0x41, 0xd7, 0x2b, 0x6c, 0xf3, 0x18, 0xa5, 0x7d, 0xe0, 0x34, 0xbb, 0x52,
  0xc9, 0x86, 0x1f,
]);

/** Must match AL_KEY_MAX / AL_ID_MAX in antileak_id.c. */
const KEY_MAX = 64;
const ID_MAX = 200;
const KEY_LEN = 32;

const KEYLEN_OFF = SLOT_MAGIC.length;
const KEY_OFF = KEYLEN_OFF + 1;
const IDLEN_OFF = KEY_OFF + KEY_MAX;
const ID_OFF = IDLEN_OFF + 1;

/** R2 key of the template published by the build-id-dll workflow. */
export const ID_TEMPLATE_KEY = "antileak/id/antileak_id.dll";

/** Path the entry takes inside the build package. */
export const ID_DLL_ENTRY = "antileak_id.dll";

export class StampError extends Error {}

function findSlot(image: Uint8Array): number {
  const hits: number[] = [];
  const last = image.length - SLOT_MAGIC.length;
  outer: for (let i = 0; i <= last; i++) {
    if (image[i] !== SLOT_MAGIC[0]) continue;
    for (let j = 1; j < SLOT_MAGIC.length; j++) {
      if (image[i + j] !== SLOT_MAGIC[j]) continue outer;
    }
    hits.push(i);
    if (hits.length > 1) break;
  }

  if (hits.length !== 1) {
    throw new StampError(
      `expected exactly 1 id slot in the template, found ${hits.length}`,
    );
  }
  return hits[0];
}

export async function deriveIdKey(
  secret: string,
  buildId: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`antileak-id:${buildId}`),
  );
  return new Uint8Array(mac).subarray(0, KEY_LEN);
}

export function stampBuildId(
  template: Uint8Array,
  buildId: string,
  key: Uint8Array,
): Uint8Array {
  const id = new TextEncoder().encode(buildId);
  if (id.length === 0) throw new StampError("build id is empty");
  if (id.length > ID_MAX)
    throw new StampError(`build id is ${id.length} bytes, max is ${ID_MAX}`);
  for (const b of id) {
    if (b > 0x7f) throw new StampError("build id must be ASCII");
  }
  if (key.length === 0 || key.length > KEY_MAX) {
    throw new StampError(`key is ${key.length} bytes, must be 1..${KEY_MAX}`);
  }

  const slot = findSlot(template);
  const out = new Uint8Array(template);

  out[slot + KEYLEN_OFF] = key.length;
  out.set(key, slot + KEY_OFF);
  out[slot + IDLEN_OFF] = id.length;
  for (let i = 0; i < id.length; i++) {
    out[slot + ID_OFF + i] = id[i] ^ key[i % key.length];
  }
  return out;
}

export function readStampedId(image: Uint8Array): string {
  const slot = findSlot(image);
  const keyLen = image[slot + KEYLEN_OFF];
  const n = image[slot + IDLEN_OFF];
  if (keyLen === 0 || keyLen > KEY_MAX || n > ID_MAX) return "";
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = image[slot + ID_OFF + i] ^ image[slot + KEY_OFF + (i % keyLen)];
  }
  return new TextDecoder().decode(out);
}

interface CachedTemplate {
  etag: string;
  bytes: Uint8Array;
}

let templateCache: CachedTemplate | null = null;

export async function loadIdTemplate(bucket: R2Bucket): Promise<Uint8Array> {
  const head = await bucket.head(ID_TEMPLATE_KEY);
  if (!head) {
    throw new StampError(
      `${ID_TEMPLATE_KEY} is not in R2 - run the build-id-dll workflow in the antileak repo to publish it`,
    );
  }
  if (templateCache && templateCache.etag === head.etag)
    return templateCache.bytes;

  const obj = await bucket.get(ID_TEMPLATE_KEY);
  if (!obj)
    throw new StampError(`${ID_TEMPLATE_KEY} vanished between head and get`);
  const bytes = new Uint8Array(await obj.arrayBuffer());

  findSlot(bytes);

  templateCache = { etag: obj.etag, bytes };
  return bytes;
}
