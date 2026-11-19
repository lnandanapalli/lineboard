import type { Store } from './store/store';
import type { AppUser, Settings, Stroke } from './types';

/**
 * "Download my data": everything the account (or this device, in guest mode) holds, in an open,
 * machine-readable form (data portability, GDPR art. 20). A zip with:
 *   lineboard-data.json  account, settings, notebooks > notes > strokes (decrypted, if encrypted)
 *   pictures/<id>.<ext>  the picture files (decrypted)
 *   README.txt           what is in it
 */

// ----------------------------- a minimal zip writer (stored, no compression) -----------------------------

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

/** Build a zip archive. Files are stored as they are (pictures are compressed already). */
export function zip(files: { name: string; data: Uint8Array }[], date = new Date()): Blob {
  const enc = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, new Uint8Array(f.data));
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ----------------------------- collecting the data -----------------------------

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' };

/** Everything this account (or device) holds, as a zip. `onProgress` gets (notes done, total). */
export async function buildExport(store: Store, user: AppUser, settings: Settings, onProgress: (done: number, total: number) => void = () => {}): Promise<Blob> {
  const enc = new TextEncoder();
  const [books, notes] = await Promise.all([store.listNotebooks(), store.listNotes()]);
  const files: { name: string; data: Uint8Array }[] = [];
  const missing: string[] = [];
  const strokesOf = new Map<string, Stroke[]>();
  onProgress(0, notes.length);
  for (let i = 0; i < notes.length; i++) {
    const strokes = await store.loadStrokes(notes[i].id);
    strokesOf.set(notes[i].id, strokes);
    for (const s of strokes) {
      if (s.tool !== 'image' || !s.text) continue;
      try {
        const blob = await store.getImage(s.text, s.color);
        files.push({ name: `pictures/${s.text}.${EXT[s.color] ?? 'bin'}`, data: new Uint8Array(await blob.arrayBuffer()) });
      } catch {
        missing.push(s.text); // listed in the JSON; the stroke still describes where it was
      }
    }
    onProgress(i + 1, notes.length);
  }
  const data = {
    format: 'lineboard-export',
    version: 1,
    exported_at: new Date().toISOString(),
    account: store.mode === 'cloud' ? { id: user.id, email: user.email } : { local: true, note: 'Notes kept in this browser without an account.' },
    settings,
    notebooks: books.map((b) => ({
      ...b,
      notes: notes
        .filter((n) => n.notebook_id === b.id)
        .map((n) => ({ ...n, strokes: strokesOf.get(n.id) ?? [] })),
    })),
    // Notes not in any notebook (older data, before notebooks existed).
    unfiled_notes: notes.filter((n) => !books.some((b) => b.id === n.notebook_id)).map((n) => ({ ...n, strokes: strokesOf.get(n.id) ?? [] })),
    ...(missing.length ? { missing_pictures: missing } : {}),
  };
  const readme = [
    'Lineboard data export',
    '',
    'lineboard-data.json   Your account details, settings, notebooks, notes and everything drawn on them.',
    '                      Each stroke: tool (pen, highlighter, text or image), colour, width, and points as',
    '                      a flat list x, y, pressure, x, y, pressure... in page units (the page is 1000 wide).',
    '                      Text boxes keep their text; pictures point at a file in pictures/ by id.',
    'pictures/             The picture files, decrypted if your account uses end-to-end encryption.',
    '',
    `Exported ${new Date().toUTCString()}.`,
  ].join('\n');
  files.unshift({ name: 'lineboard-data.json', data: enc.encode(JSON.stringify(data, null, 2)) }, { name: 'README.txt', data: enc.encode(readme) });
  return zip(files);
}
