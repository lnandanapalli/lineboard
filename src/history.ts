import { cleanStyle, isPlain } from './textStyle';
import type { Stroke } from './types';

/**
 * Version history: a note's past states, as full snapshots of its strokes.
 *
 * History is one straight line. Restoring an old version never deletes anything: it adds a new
 * version at the top with the old content (kind 'restore'), so every version can be compared with
 * the one before it, the restore included. A copy of a version is a new note, starting fresh or
 * with the history up to that version.
 *
 * Snapshots hold stroke content only, without ids: two versions are compared by what the strokes
 * are (a stroke that did not change is equal in both), so a snapshot can move between notes and
 * files without any id bookkeeping.
 */

export type VersionKind = 'auto' | 'restore';

export interface VersionMeta {
  id: string;
  note_id: string;
  created_at: string;
  kind: VersionKind;
  /** Named versions are kept until the name is removed; unnamed ones thin out over time. */
  name: string | null;
  /** A restore: when the version it brought back was made. */
  restored_from: string | null;
}

/** A stroke inside a snapshot: its content, without ids. Pictures keep their image id in `text`. */
export type SnapStroke = Pick<Stroke, 'tool' | 'color' | 'width' | 'points'> & Partial<Pick<Stroke, 'text' | 'dash' | 'font' | 'created_at'>>;

export const toSnap = (s: Stroke): SnapStroke => ({
  tool: s.tool,
  color: s.color,
  width: s.width,
  points: s.points,
  ...(s.tool === 'text' || s.tool === 'image' ? { text: s.text ?? '' } : {}),
  ...(s.dash ? { dash: s.dash } : {}),
  ...(s.tool === 'text' && !isPlain(s.font) ? { font: cleanStyle(s.font) } : {}),
  ...(s.created_at ? { created_at: s.created_at } : {}),
});

export const fromSnap = (s: SnapStroke, noteId: string, id: string): Stroke => ({ ...s, id, note_id: noteId });

/** What a stroke looks like, for comparing versions (when it was drawn does not matter). */
export const signature = (s: SnapStroke) => JSON.stringify([s.tool, s.color, s.width, s.points, s.text ?? '', s.dash ?? '', s.tool === 'text' && !isPlain(s.font) ? cleanStyle(s.font) : null]);

const SNAPSHOT_VERSION = 1;

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A snapshot as compact bytes (deflated JSON). */
export async function encodeSnapshot(strokes: SnapStroke[]): Promise<Uint8Array<ArrayBuffer>> {
  const json = new TextEncoder().encode(JSON.stringify({ v: SNAPSHOT_VERSION, strokes }));
  return pipe(json, new CompressionStream('deflate-raw'));
}

/** Largest snapshot accepted (unpacked), so a damaged or hostile row cannot exhaust memory. */
const MAX_SNAPSHOT = 200_000_000;

export async function decodeSnapshot(bytes: Uint8Array<ArrayBuffer>): Promise<SnapStroke[]> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SNAPSHOT) {
      await reader.cancel();
      throw new Error('This version is too large to open.');
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const doc = JSON.parse(new TextDecoder().decode(all)) as { v?: number; strokes?: SnapStroke[] };
  if (!Array.isArray(doc.strokes)) throw new Error('This version is damaged.');
  return doc.strokes;
}

/** A short fingerprint of a note's content, to skip saving a version identical to the last one. */
export async function contentHash(strokes: SnapStroke[]): Promise<string> {
  const sigs = strokes.map(signature).sort();
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sigs.join('\n')));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What changed from `before` to `after`: which strokes of `after` are new (by index), and which
 * strokes of `before` are gone. Equal strokes are matched one to one, so a duplicate counts.
 */
export function diff(before: SnapStroke[], after: SnapStroke[]): { added: Set<number>; removed: SnapStroke[] } {
  const pool = new Map<string, number>();
  for (const s of before) {
    const k = signature(s);
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const added = new Set<number>();
  after.forEach((s, i) => {
    const k = signature(s);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else added.add(i);
  });
  const removed: SnapStroke[] = [];
  for (const s of before) {
    const k = signature(s);
    const n = pool.get(k) ?? 0;
    if (n > 0) {
      pool.set(k, n - 1);
      removed.push(s);
    }
  }
  return { added, removed };
}

/**
 * The plan to turn the note's current strokes into a version's: which current strokes to delete,
 * and which snapshot strokes to add. Strokes are drawn in order (later ones on top) and added ones go
 * on top, so only the strokes the two share from the start stay; from the first difference on, the
 * rest is replaced, which keeps the version's layering exactly.
 */
export function restorePlan(current: Stroke[], target: SnapStroke[]): { remove: Stroke[]; add: SnapStroke[] } {
  let i = 0;
  while (i < current.length && i < target.length && signature(toSnap(current[i])) === signature(target[i])) i++;
  return { remove: current.slice(i), add: target.slice(i) };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Which versions to let go, so history stays useful without growing forever. Named versions and the
 * newest one are always kept. Unnamed ones: every one from the last day, then the newest of each
 * hour for a week, then the newest of each day for 90 days; older ones go. Also at most `cap`
 * versions in all (the oldest unnamed ones go first).
 */
export function toPrune(versions: VersionMeta[], now = Date.now(), cap = 400): VersionMeta[] {
  const sorted = [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const keep = new Set<VersionMeta>();
  const buckets = new Set<string>();
  sorted.forEach((v, i) => {
    const age = now - Date.parse(v.created_at);
    if (i === 0 || v.name || age < DAY) return void keep.add(v);
    const bucket = age < 7 * DAY ? 'h' + Math.floor(Date.parse(v.created_at) / HOUR) : age < 90 * DAY ? 'd' + Math.floor(Date.parse(v.created_at) / DAY) : null;
    if (bucket && !buckets.has(bucket)) {
      buckets.add(bucket);
      keep.add(v);
    }
  });
  let kept = sorted.filter((v) => keep.has(v));
  while (kept.length > cap) {
    const oldest = [...kept].reverse().find((v, i) => !v.name && i < kept.length - 1);
    if (!oldest) break;
    kept = kept.filter((v) => v !== oldest);
  }
  const final = new Set(kept);
  return sorted.filter((v) => !final.has(v));
}

/** How long writing must pause before a version is saved, and the longest a change waits. */
export const IDLE_MS = 2 * 60_000;
export const MAX_WAIT_MS = 10 * 60_000;
