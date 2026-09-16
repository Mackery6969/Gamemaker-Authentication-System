const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

const EOCD_MIN_SIZE = 22;
const LOCAL_HEADER_SIZE = 30;
const CD_RECORD_SIZE = 46;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const EXTERNAL_ATTRS = 0o600 << 16;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(buf: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  u16(v: number): this {
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  bytes(v: Uint8Array): this {
    this.buf.set(v, this.pos);
    this.pos += v.length;
    return this;
  }

  done(): Uint8Array {
    if (this.pos !== this.buf.length) {
      throw new Error(
        `zipmint: wrote ${this.pos} bytes, expected ${this.buf.length}`,
      );
    }
    return this.buf;
  }
}

export interface ZipDirectory {
  cdOffset: number;
  cdSize: number;
  entryCount: number;
}

export const ZIP_TAIL_PROBE = 128 * 1024;

export class ZipUnsupported extends Error {}

export function parseZipDirectory(
  tail: Uint8Array,
  totalSize: number,
): ZipDirectory {
  const tailStart = totalSize - tail.length;
  if (tailStart < 0) throw new ZipUnsupported("tail longer than object");

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + EOCD_MIN_SIZE + commentLen === tail.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0)
    throw new ZipUnsupported("no end-of-central-directory record found");

  const diskNumber = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  if (diskNumber !== 0 || cdDisk !== 0 || diskEntries !== entryCount) {
    throw new ZipUnsupported("multi-disk archive");
  }
  if (entryCount === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    throw new ZipUnsupported("zip64 archive");
  }
  for (let i = 0; i + 4 <= eocd; i++) {
    if (view.getUint32(i, true) === SIG_ZIP64_EOCD_LOCATOR) {
      throw new ZipUnsupported(
        "zip64 end-of-central-directory locator present",
      );
    }
  }
  if (cdOffset + cdSize !== tailStart + eocd) {
    throw new ZipUnsupported(
      "central directory is not contiguous with the EOCD",
    );
  }
  if (cdOffset > totalSize)
    throw new ZipUnsupported("central directory offset out of range");

  return { cdOffset, cdSize, entryCount };
}

/** Whether the central directory already lists `name`. */
export function directoryHasEntry(cdBytes: Uint8Array, name: string): boolean {
  const view = new DataView(
    cdBytes.buffer,
    cdBytes.byteOffset,
    cdBytes.byteLength,
  );
  const wanted = new TextEncoder().encode(name);
  let p = 0;
  while (p + CD_RECORD_SIZE <= cdBytes.length) {
    if (view.getUint32(p, true) !== SIG_CD) break;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (nameLen === wanted.length) {
      let same = true;
      for (let i = 0; i < nameLen; i++) {
        if (cdBytes[p + CD_RECORD_SIZE + i] !== wanted[i]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
    p += CD_RECORD_SIZE + nameLen + extraLen + commentLen;
  }
  return false;
}

export interface MintedZip {
  totalSize: number;
  baseLength: number;
  tail: Uint8Array;
}

export function planStoredAppend(
  dir: ZipDirectory,
  cdBytes: Uint8Array,
  name: string,
  data: Uint8Array,
): MintedZip {
  if (cdBytes.length !== dir.cdSize) {
    throw new ZipUnsupported(
      `central directory is ${cdBytes.length} bytes, expected ${dir.cdSize}`,
    );
  }
  if (directoryHasEntry(cdBytes, name)) {
    throw new ZipUnsupported(
      `${name} is already present in the base package - base-build did not strip it`,
    );
  }
  if (dir.entryCount + 1 > U16_MAX)
    throw new ZipUnsupported("appending would exceed the zip64 entry limit");

  const nameBytes = new TextEncoder().encode(name);
  const localOffset = dir.cdOffset;
  const entrySize = LOCAL_HEADER_SIZE + nameBytes.length + data.length;
  const newCdOffset = localOffset + entrySize;

  if (
    newCdOffset > U32_MAX ||
    newCdOffset + dir.cdSize + CD_RECORD_SIZE + nameBytes.length > U32_MAX
  ) {
    throw new ZipUnsupported(
      "appending would push the archive past the 4 GiB zip64 boundary",
    );
  }

  const sum = crc32(data);

  const local = new ByteWriter(LOCAL_HEADER_SIZE + nameBytes.length)
    .u32(SIG_LOCAL)
    .u16(20) // version needed
    .u16(0) // flags
    .u16(0) // method: stored
    .u16(DOS_TIME)
    .u16(DOS_DATE)
    .u32(sum)
    .u32(data.length) // compressed size
    .u32(data.length) // uncompressed size
    .u16(nameBytes.length)
    .u16(0) // extra length
    .bytes(nameBytes)
    .done();

  const record = new ByteWriter(CD_RECORD_SIZE + nameBytes.length)
    .u32(SIG_CD)
    .u16(20) // version made by
    .u16(20) // version needed
    .u16(0) // flags
    .u16(0) // method: stored
    .u16(DOS_TIME)
    .u16(DOS_DATE)
    .u32(sum)
    .u32(data.length)
    .u32(data.length)
    .u16(nameBytes.length)
    .u16(0) // extra length
    .u16(0) // comment length
    .u16(0) // disk number start
    .u16(0) // internal attributes
    .u32(EXTERNAL_ATTRS) // external attributes
    .u32(localOffset)
    .bytes(nameBytes)
    .done();

  const newCdSize = dir.cdSize + record.length;
  const eocd = new ByteWriter(EOCD_MIN_SIZE)
    .u32(SIG_EOCD)
    .u16(0)
    .u16(0)
    .u16(dir.entryCount + 1)
    .u16(dir.entryCount + 1)
    .u32(newCdSize)
    .u32(newCdOffset)
    .u16(0)
    .done();

  const tail = new Uint8Array(entrySize + newCdSize + EOCD_MIN_SIZE);
  let p = 0;
  tail.set(local, p);
  p += local.length;
  tail.set(data, p);
  p += data.length;
  tail.set(cdBytes, p);
  p += cdBytes.length;
  tail.set(record, p);
  p += record.length;
  tail.set(eocd, p);
  p += eocd.length;
  if (p !== tail.length)
    throw new Error("zipmint: tail assembly length mismatch");

  return {
    totalSize: localOffset + tail.length,
    baseLength: localOffset,
    tail,
  };
}
