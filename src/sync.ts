import type { Store } from './store/store';
import { StoreError } from './store/store';
import type { Stroke } from './types';
import { lsDel, lsGet, lsSet, uuid } from './util';

type Op = { kind: 'upsert'; strokes: Stroke[] } | { kind: 'delete'; ids: string[] };
/** One queued change, stored on its own (see SyncQueue). `order` keeps changes in the order made. */
interface Entry {
  id: string;
  order: number;
  op: Op;
}
export type SyncState = 'saved' | 'saving' | 'retrying';

let seq = 0;
/** Increasing across tabs (time first), so changes from several tabs keep the order they were made in. */
const nextOrder = () => Date.now() * 1000 + (seq = (seq + 1) % 1000);

/**
 * Serial, persistent write queue. Every stroke change is queued and saved in the background,
 * survives reloads and retries with backoff while offline.
 *
 * Each change is its own localStorage entry (`<key>:<id>`), written once and removed by its id when
 * saved, so tabs never overwrite each other's waiting changes and finishing one change can never
 * remove another. One tab at a time sends them (a Web Lock), in order, including other tabs' changes.
 */
export class SyncQueue {
  /** Changes waiting, in order: those in storage (any tab's) plus any that storage could not hold. */
  private entries: Entry[] = [];
  /** Changes kept in memory only because storage was full when they were made. */
  private memOnly = new Map<string, Entry>();
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  state: SyncState = 'saved';
  onState: (s: SyncState) => void = () => {};
  /** A change the server will never accept (e.g. a fair-use limit) was dropped: tell the user why. */
  onDropped: (message: string, error: StoreError) => void = () => {};
  /** The browser's storage is full: waiting changes are kept in memory only, so closing the page would lose them. */
  onStorageFull: () => void = () => {};
  /** A save failed and will be tried again; `first` is true for the first failure in a row. */
  onRetry: (error: unknown, first: boolean) => void = () => {};
  private full = false;
  private readonly prefix: string;

  constructor(
    private store: Store,
    private key: string,
  ) {
    this.prefix = key + ':';
    this.migrate();
    this.load();
    window.addEventListener('online', () => this.wake?.());
    // Another tab queued or saved something: keep the count and the overlay current.
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key.startsWith(this.prefix)) this.load();
    });
    if (this.entries.length) void this.run();
  }

  /** The old format kept the whole queue in one value; split it into entries. */
  private migrate() {
    const old = lsGet<Op[] | null>(this.key, null);
    if (!Array.isArray(old)) return;
    for (const op of old) this.write({ id: uuid(), order: nextOrder(), op });
    lsDel(this.key);
  }

  /** Read every waiting change from storage (all tabs'), plus this tab's memory-only ones. */
  private load() {
    const found: Entry[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith(this.prefix)) continue;
        const e = lsGet<Entry | null>(k, null);
        if (e && e.op && typeof e.order === 'number') found.push(e);
      }
    } catch {
      /* storage unavailable: memory only */
    }
    const ids = new Set(found.map((e) => e.id));
    for (const e of this.memOnly.values()) if (!ids.has(e.id)) found.push(e);
    found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    this.entries = found;
  }

  /** Store one entry; if storage is full, keep it in memory and say so. */
  private write(e: Entry) {
    const ok = lsSet(this.prefix + e.id, e);
    if (ok) this.memOnly.delete(e.id);
    else this.memOnly.set(e.id, e);
    if (!ok && !this.full) this.onStorageFull();
    this.full = !ok;
  }

  /** Remove exactly this change (by its id), wherever it is. */
  private forget(id: string) {
    lsDel(this.prefix + id);
    this.memOnly.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** Stop saving (the app is being torn down); queued work stays persisted for the next queue. */
  stop() {
    this.stopped = true;
    this.wake?.();
  }

  get pending() {
    return this.entries.length;
  }

  upsert(strokes: Stroke[]) {
    if (strokes.length) this.push({ kind: 'upsert', strokes });
  }

  remove(ids: string[]) {
    if (ids.length) this.push({ kind: 'delete', ids });
  }

  /** Drop queued work for a note that was deleted. Each affected entry is rewritten or removed by id. */
  dropNote(noteId: string) {
    this.load();
    for (const e of [...this.entries]) {
      if (e.op.kind !== 'upsert' || !e.op.strokes.some((s) => s.note_id === noteId)) continue;
      const strokes = e.op.strokes.filter((s) => s.note_id !== noteId);
      if (!strokes.length) this.forget(e.id);
      else {
        const next = { ...e, op: { kind: 'upsert' as const, strokes } };
        this.write(next);
        this.entries = this.entries.map((x) => (x.id === e.id ? next : x));
      }
    }
  }

  /** Apply unsynced changes on top of strokes freshly loaded from the server. */
  overlay(noteId: string, loaded: Stroke[]): Stroke[] {
    const map = new Map(loaded.map((s) => [s.id, s]));
    for (const { op: o } of this.entries) {
      if (o.kind === 'upsert') for (const s of o.strokes) if (s.note_id === noteId) map.set(s.id, s);
      if (o.kind === 'delete') for (const id of o.ids) map.delete(id);
    }
    return [...map.values()];
  }

  private push(op: Op) {
    if (this.stopped) return;
    const e: Entry = { id: uuid(), order: nextOrder(), op };
    this.write(e);
    this.entries.push(e);
    void this.run();
  }

  private setState(s: SyncState) {
    if (s !== this.state) {
      this.state = s;
      this.onState(s);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((res) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        res();
      }
      this.wake = done;
    });
  }

  /** Send waiting changes, one tab at a time (other tabs' changes included). */
  private async run() {
    if (this.running) return;
    this.running = true;
    this.setState('saving');
    try {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (locks) await locks.request(this.key, () => this.drain());
      else await this.drain();
    } finally {
      this.running = false;
    }
    this.load();
    // Something was queued while another tab held the lock and has not been sent yet: go again.
    if (!this.stopped && this.entries.length) return void this.run();
    if (!this.stopped) this.setState('saved');
  }

  private async drain() {
    let delay = 0;
    for (;;) {
      if (this.stopped) return;
      this.load(); // pick up other tabs' changes, and drop what another tab already sent
      const e = this.entries[0];
      if (!e) return;
      this.setState(delay ? 'retrying' : 'saving');
      try {
        if (e.op.kind === 'upsert') await this.store.upsertStrokes(e.op.strokes);
        else await this.store.deleteStrokes(e.op.ids);
        this.forget(e.id);
        delay = 0;
      } catch (err) {
        if (err instanceof StoreError && err.permanent) {
          // Rewritten meanwhile (a note in it was deleted): send what is left instead of dropping it.
          this.load();
          const now = this.entries.find((x) => x.id === e.id);
          if (now && JSON.stringify(now.op) !== JSON.stringify(e.op)) continue;
          console.error('Dropping unsavable change:', err.message);
          this.forget(e.id);
          this.onDropped(err.message, err);
          continue;
        }
        console.warn('Save failed, will retry:', err);
        this.onRetry(err, delay === 0);
        delay = Math.min(30000, delay ? delay * 2 : 2000);
        this.setState('retrying');
        await this.sleep(delay);
      }
    }
  }
}
