/**
 * ZIP archives without a dependency: a writer (stored or deflated entries) and a reader (stored or
 * deflated, as made by Lineboard, Finder, Windows, `zip`...). Compression uses the browser's own
 * CompressionStream / DecompressionStream ('deflate-raw').
 *
 * The reader handles files from anywhere, so it is strict: it reads the central directory, refuses
 * encrypted, multi-disk and zip64 archives, checks every CRC, and stops at the given limits on the
 * number of entries and the total unpacked size (a "zip bomb" is refused, not unpacked).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ZipError('The file unpacks to more than it says (damaged, or not a real archive).');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** Compress (deflate) this entry; worth it for text, not for pictures (already compressed). */
  compress?: boolean;
}

/** Build a zip archive. */
export async function zip(files: ZipEntry[], type = 'application/zip', date = new Date()): Promise<Blob> {
  const enc = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    let body = f.data;
    let method = 0;
    if (f.compress && f.data.length > 64) {
      const packed = await through(f.data, new CompressionStream('deflate-raw'));
      if (packed.length < f.data.length) {
        body = packed;
        method = 8;
      }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, new Uint8Array(body));
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}

export interface UnzipLimits {
  maxEntries: number;
  /** Total unpacked bytes across all entries. */
  maxTotal: number;
  /** Unpacked bytes for one entry. */
  maxEntry: number;
}

/** Is this the start of a zip archive? */
export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Read a zip archive into name -> bytes. Folders and macOS resource forks are skipped. */
/** Unpacked bytes left for a whole import that reads several archives (one inside another). */
export interface UnzipBudget {
  bytes: number;
}

/**
 * The names in a zip archive, from its central directory only (nothing is unpacked), to decide which
 * limits to read it with. Damaged or unsupported archives throw, like unzip.
 */
export function zipNames(buf: Uint8Array): string[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip archive (or it is damaged).');
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('Very large (zip64) archives are not supported.');
  const dec = new TextDecoder();
  const names: string[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw new ZipError('The archive is damaged.');
    const nameLen = v.getUint16(p + 28, true);
    names.push(dec.decode(buf.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return names;
}

export async function unzip(buf: Uint8Array, limits: UnzipLimits, budget?: UnzipBudget): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: the last 22 bytes, or up to 64 KiB earlier with a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip archive (or it is damaged).');
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) throw new ZipError('Multi-part archives are not supported.');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('Very large (zip64) archives are not supported.');
  if (count > limits.maxEntries) throw new ZipError(`Too many files in the archive (at most ${limits.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw new ZipError('The archive is damaged.');

  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw new ZipError('The archive is damaged.');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const packed = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localAt = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError('Password-protected archives are not supported.');
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()!.startsWith('._')) continue;
    if (size > limits.maxEntry) throw new ZipError(`"${name}" is too large.`);
    total += size;
    if (total > limits.maxTotal) throw new ZipError('The archive is too large to import.');
    if (budget && (budget.bytes -= size) < 0) throw new ZipError('The archive is too large to import.');
    if (localAt + 30 > buf.length || v.getUint32(localAt, true) !== 0x04034b50) throw new ZipError('The archive is damaged.');
    const start = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
    if (start + packed > buf.length) throw new ZipError('The archive is damaged.');
    const raw = buf.subarray(start, start + packed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) data = await through(raw, new DecompressionStream('deflate-raw'), size);
    else throw new ZipError(`"${name}" uses a compression method that is not supported.`);
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`"${name}" is damaged.`);
    out.set(name, data);
  }
  return out;
}
