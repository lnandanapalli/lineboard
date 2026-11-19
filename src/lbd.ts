import { prepareImage } from './images';
import type { Store } from './store/store';
import { cleanStyle, isPlain } from './textStyle';
import type { Notebook, NoteMeta, Stroke } from './types';
import { uuid } from './util';
import { isZip, unzip, zip, ZipError, type ZipEntry } from './zip';

/**
 * The Lineboard document (.lbd): notes as a file, to keep, share or move between accounts.
 *
 * An .lbd is a ZIP archive (like .docx), so pictures travel inside it and any zip tool can open it:
 *
 *   lineboard.json        the manifest: { format: "lineboard", version: 1, exported_at, notebooks: [
 *                           { name, notes: [ { file: "notes/0001.json" }, ... ] }, ... ] }
 *   notes/0001.json       one note: { title, created_at, updated_at, strokes: [...] }
 *   pictures/<name>.png   the pictures the notes use (PNG or JPEG)
 *
 * A stroke: { tool: "pen" | "highlighter" | "text" | "image", color, width, points, created_at? }
 * plus, by tool, `text` and `font` (text boxes), `dash` (dashed / dotted shapes), `picture` (the
 * picture's path in the archive; `color` is then its file type). `points` is a flat list
 * x, y, pressure, x, y, pressure... in page units, the page being 1000 wide. Ids are not stored:
 * an import makes new ones, so importing never overwrites anything. The full description is in
 * docs/file-format.md.
 */

export const LBD_EXT = '.lbd';
export const LBD_TYPE = 'application/vnd.lineboard+zip';
export const LBD_VERSION = 1;

export interface LbdStroke {
  tool: Stroke['tool'];
  color: string;
  width: number;
  points: number[];
  text?: string;
  dash?: Stroke['dash'];
  font?: Stroke['font'];
  picture?: string;
  created_at?: string;
}
export interface LbdNote {
  title: string;
  created_at?: string;
  updated_at?: string;
  strokes: LbdStroke[];
}
/** What a file holds once read and checked: notebooks of notes, and the picture files. */
export interface LbdDocument {
  notebooks: { name: string; notes: LbdNote[] }[];
  pictures: Map<string, Blob>;
  /** Strokes left out because they were not valid. */
  skipped: number;
}

// ----------------------------- writing -----------------------------

const PICTURE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** A file name from a title: no path characters, not too long. */
export const fileName = (title: string, ext = LBD_EXT) => (title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled') + ext;

/**
 * Build an .lbd from notebooks and their notes. `pending` applies changes not yet saved (the sync
 * queue), so the file matches what the user sees.
 */
export async function buildLbd(
  store: Store,
  groups: { notebook: Pick<Notebook, 'name'>; notes: NoteMeta[] }[],
  pending: (noteId: string, saved: Stroke[]) => Stroke[] = (_, s) => s,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<Blob> {
  const enc = new TextEncoder();
  const files: ZipEntry[] = [];
  const total = groups.reduce((n, g) => n + g.notes.length, 0);
  let done = 0;
  const manifest = { format: 'lineboard', version: LBD_VERSION, exported_at: new Date().toISOString(), notebooks: [] as { name: string; notes: { file: string }[] }[] };
  for (const g of groups) {
    const book = { name: g.notebook.name, notes: [] as { file: string }[] };
    for (const n of g.notes) {
      const strokes = pending(n.id, await store.loadStrokes(n.id));
      const out: LbdStroke[] = [];
      for (const s of strokes) {
        const base: LbdStroke = { tool: s.tool, color: s.color, width: s.width, points: s.points, ...(s.created_at ? { created_at: s.created_at } : {}) };
        if (s.tool === 'image') {
          if (!s.text) continue;
          try {
            const blob = await store.getImage(s.text, s.color);
            const path = `pictures/${s.text}.${PICTURE_EXT[s.color] ?? 'png'}`;
            if (!files.some((f) => f.name === path)) files.push({ name: path, data: new Uint8Array(await blob.arrayBuffer()) });
            out.push({ ...base, picture: path });
          } catch {
            /* the picture could not be read (deleted, or encrypted and locked): leave it out */
          }
          continue;
        }
        if (s.tool === 'text') out.push({ ...base, text: s.text ?? '', ...(isPlain(s.font) ? {} : { font: cleanStyle(s.font) }) });
        else out.push({ ...base, ...(s.dash ? { dash: s.dash } : {}) });
      }
      const file = `notes/${String(++done).padStart(4, '0')}.json`;
      const note: LbdNote = { title: n.title, created_at: n.created_at, updated_at: n.updated_at, strokes: out };
      files.push({ name: file, data: enc.encode(JSON.stringify(note)), compress: true });
      book.notes.push({ file });
      onProgress(done, total);
    }
    manifest.notebooks.push(book);
  }
  files.unshift({ name: 'lineboard.json', data: enc.encode(JSON.stringify(manifest, null, 2)), compress: true });
  return zip(files, LBD_TYPE);
}

// ----------------------------- reading -----------------------------

/** Files come from anywhere: generous limits for real notes, refusals for anything bigger. */
const LIMITS = { maxEntries: 30_000, maxTotal: 1_500_000_000, maxEntry: 60_000_000 };
const MAX_NOTES = 20_000;
const MAX_STROKES = 50_000;
const MAX_POINTS = 60_000; // numbers in one stroke's points (20,000 x, y, pressure triples)
const MAX_PICTURE = 15 * 1024 * 1024;
const TOOLS = new Set(['pen', 'highlighter', 'text', 'image']);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const PICTURE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };

export class LbdError extends Error {}

const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

/** One stroke from a file, checked; null when it is not valid. */
function readStroke(raw: unknown, pictures: Map<string, Blob>): LbdStroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!TOOLS.has(r.tool as string)) return null;
  const tool = r.tool as Stroke['tool'];
  const width = r.width;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 100) return null;
  const pts = r.points;
  if (!Array.isArray(pts) || pts.length < 3 || pts.length % 3 || pts.length > MAX_POINTS) return null;
  if (!pts.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7)) return null;
  const created_at = date(r.created_at);
  const base = { tool, width, points: pts as number[], ...(created_at ? { created_at } : {}) };
  if (tool === 'image') {
    const path = r.picture;
    if (typeof path !== 'string' || !pictures.has(path) || pts.length !== 6) return null;
    return { ...base, color: pictures.get(path)!.type, picture: path };
  }
  const color = r.color;
  if (typeof color !== 'string' || !COLOR.test(color)) return null;
  if (tool === 'text') return { ...base, color, text: str(r.text, 10_000), ...(isPlain(r.font as Stroke['font']) ? {} : { font: cleanStyle(r.font) }) };
  return { ...base, color, ...(r.dash === 'dashed' || r.dash === 'dotted' ? { dash: r.dash } : {}) };
}

/** Read one .lbd archive. */
async function readLbd(bytes: Uint8Array): Promise<LbdDocument> {
  const files = await unzip(bytes, LIMITS);
  const manifestBytes = files.get('lineboard.json');
  if (!manifestBytes) throw new LbdError('This is not a Lineboard file (lineboard.json is missing).');
  let manifest: { format?: unknown; version?: unknown; notebooks?: unknown };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new LbdError('This Lineboard file is damaged (its manifest cannot be read).');
  }
  if (manifest.format !== 'lineboard') throw new LbdError('This is not a Lineboard file.');
  if (typeof manifest.version !== 'number' || manifest.version < 1) throw new LbdError('This Lineboard file is damaged (no version).');
  if (manifest.version > LBD_VERSION) throw new LbdError('This file was made by a newer version of Lineboard. Reload the page to update, then try again.');
  if (!Array.isArray(manifest.notebooks)) throw new LbdError('This Lineboard file is damaged (no notebooks).');

  const pictures = new Map<string, Blob>();
  for (const [name, data] of files) {
    const m = /^pictures\/[^/]+\.([a-z0-9]+)$/i.exec(name);
    const type = m && PICTURE_TYPES[m[1].toLowerCase()];
    if (type && data.length <= MAX_PICTURE) pictures.set(name, new Blob([data as Uint8Array<ArrayBuffer>], { type }));
  }

  const doc: LbdDocument = { notebooks: [], pictures, skipped: 0 };
  let noteCount = 0;
  for (const rawBook of manifest.notebooks) {
    if (!rawBook || typeof rawBook !== 'object') continue;
    const b = rawBook as { name?: unknown; notes?: unknown };
    const book = { name: str(b.name, 120).trim() || 'Imported notes', notes: [] as LbdNote[] };
    for (const ref of Array.isArray(b.notes) ? b.notes : []) {
      if (++noteCount > MAX_NOTES) throw new LbdError(`This file has more than ${MAX_NOTES.toLocaleString()} notes.`);
      const path = (ref as { file?: unknown })?.file;
      const data = typeof path === 'string' ? files.get(path) : undefined;
      if (!data) throw new LbdError('This Lineboard file is damaged (a note is missing).');
      let raw: { title?: unknown; created_at?: unknown; updated_at?: unknown; strokes?: unknown };
      try {
        raw = JSON.parse(new TextDecoder().decode(data));
      } catch {
        throw new LbdError('This Lineboard file is damaged (a note cannot be read).');
      }
      const list = Array.isArray(raw.strokes) ? raw.strokes : [];
      if (list.length > MAX_STROKES) throw new LbdError(`A note in this file has more than ${MAX_STROKES.toLocaleString()} strokes.`);
      const strokes: LbdStroke[] = [];
      for (const s of list) {
        const ok = readStroke(s, pictures);
        if (ok) strokes.push(ok);
        else doc.skipped++;
      }
      book.notes.push({ title: str(raw.title, 200).trim() || 'Untitled', created_at: date(raw.created_at), updated_at: date(raw.updated_at), strokes });
    }
    doc.notebooks.push(book);
  }
  return doc;
}

/**
 * Read a file the user picked: an .lbd, or a .zip of .lbd files (several notes zipped together, or a
 * "Download my data" archive). Everything is checked before anything is imported.
 */
export async function readNotesFile(file: Blob): Promise<LbdDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) throw new LbdError('This is not a Lineboard file (.lbd) or a zip of them.');
  try {
    const top = await unzip(bytes, LIMITS);
    if (top.has('lineboard.json')) return await readLbd(bytes);
    // A zip of .lbd files: read each, and put them together.
    const inner = [...top].filter(([name]) => name.toLowerCase().endsWith(LBD_EXT));
    if (!inner.length) throw new LbdError('This zip has no Lineboard files (.lbd) in it.');
    const all: LbdDocument = { notebooks: [], pictures: new Map(), skipped: 0 };
    for (const [name, data] of inner) {
      const doc = await readLbd(data).catch((e: Error) => {
        throw new LbdError(`${name.split('/').pop()}: ${e.message}`);
      });
      // Picture paths are per file: give each file's pictures their own prefix.
      const prefix = `${all.notebooks.length}:`;
      for (const [p, blob] of doc.pictures) all.pictures.set(prefix + p, blob);
      for (const book of doc.notebooks)
        all.notebooks.push({ ...book, notes: book.notes.map((n) => ({ ...n, strokes: n.strokes.map((s) => (s.picture ? { ...s, picture: prefix + s.picture } : s)) })) });
      all.skipped += doc.skipped;
    }
    return all;
  } catch (e) {
    if (e instanceof ZipError) throw new LbdError(e.message);
    throw e;
  }
}

// ----------------------------- importing -----------------------------

export interface ImportResult {
  notes: NoteMeta[];
  notebooks: Notebook[];
  skipped: number;
}

/**
 * Add the notes of a document to the store, as new notes with new ids. A file with a single note
 * goes into `current`; otherwise each notebook goes into the notebook of the same name (created
 * when missing).
 */
export async function importDocument(
  store: Store,
  doc: LbdDocument,
  current: Notebook,
  existing: Notebook[],
  onProgress: (done: number, total: number) => void = () => {},
): Promise<ImportResult> {
  const total = doc.notebooks.reduce((n, b) => n + b.notes.length, 0);
  if (!total) throw new LbdError('There are no notes in this file.');
  const result: ImportResult = { notes: [], notebooks: [], skipped: doc.skipped };
  const books = [...existing];
  const uploaded = new Map<string, { id: string; type: string }>();
  let done = 0;
  for (const group of doc.notebooks) {
    if (!group.notes.length) continue;
    let target = current;
    if (total > 1) {
      const same = books.find((b) => b.name === group.name);
      if (same) target = same;
      else {
        target = await store.createNotebook(group.name);
        books.push(target);
        result.notebooks.push(target);
      }
    }
    for (const n of group.notes) {
      const note = await store.createNote(n.title, target.id);
      const strokes: Stroke[] = [];
      for (const s of n.strokes) {
        const { picture, ...rest } = s;
        const stroke: Stroke = { ...rest, id: uuid(), note_id: note.id, created_at: s.created_at ?? new Date().toISOString() } as Stroke;
        if (s.tool === 'image' && picture) {
          let pic = uploaded.get(picture);
          if (!pic) {
            try {
              // Normalised like a picture added in the app (and proven to be an image).
              const img = await prepareImage(doc.pictures.get(picture)!);
              pic = { id: uuid(), type: img.type };
              await store.putImage(pic.id, img.blob);
              uploaded.set(picture, pic);
            } catch {
              result.skipped++;
              continue;
            }
          }
          stroke.text = pic.id;
          stroke.color = pic.type;
        }
        strokes.push(stroke);
      }
      for (let i = 0; i < strokes.length; i += 500) await store.upsertStrokes(strokes.slice(i, i + 500));
      result.notes.push(note);
      onProgress(++done, total);
    }
  }
  return result;
}
