import type { Store } from './store/store';
import { StoreError } from './store/store';
import type { Stroke } from './types';
import { lsGet, lsSet } from './util';

type Op = { kind: 'upsert'; strokes: Stroke[] } | { kind: 'delete'; ids: string[] };
export type SyncState = 'saved' | 'saving' | 'retrying';

/**
 * Serial, persistent write queue. Every stroke change is queued and saved in the background,
 * survives reloads (kept in localStorage) and retries with backoff while offline.
 */
export class SyncQueue {
  private ops: Op[];
  private running = false;
  private wake: (() => void) | null = null;
  state: SyncState = 'saved';
  onState: (s: SyncState) => void = () => {};

  constructor(
    private store: Store,
    private key: string,
  ) {
    this.ops = lsGet<Op[]>(key, []);
    window.addEventListener('online', () => this.wake?.());
    if (this.ops.length) void this.run();
  }

  get pending() {
    return this.ops.length;
  }

  upsert(strokes: Stroke[]) {
    if (strokes.length) this.push({ kind: 'upsert', strokes });
  }

  remove(ids: string[]) {
    if (ids.length) this.push({ kind: 'delete', ids });
  }

  /** Drop queued work for a note that was deleted. */
  dropNote(noteId: string) {
    this.ops = this.ops
      .map((o) => (o.kind === 'upsert' ? { ...o, strokes: o.strokes.filter((s) => s.note_id !== noteId) } : o))
      .filter((o) => o.kind !== 'upsert' || o.strokes.length);
    this.persist();
  }

  /** Apply unsynced changes on top of strokes freshly loaded from the server. */
  overlay(noteId: string, loaded: Stroke[]): Stroke[] {
    const map = new Map(loaded.map((s) => [s.id, s]));
    for (const o of this.ops) {
      if (o.kind === 'upsert') for (const s of o.strokes) if (s.note_id === noteId) map.set(s.id, s);
      if (o.kind === 'delete') for (const id of o.ids) map.delete(id);
    }
    return [...map.values()];
  }

  private push(op: Op) {
    this.ops.push(op);
    this.persist();
    void this.run();
  }

  private persist() {
    lsSet(this.key, this.ops);
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

  private async run() {
    if (this.running) return;
    this.running = true;
    let delay = 0;
    while (this.ops.length) {
      this.setState(delay ? 'retrying' : 'saving');
      const op = this.ops[0];
      try {
        if (op.kind === 'upsert') await this.store.upsertStrokes(op.strokes);
        else await this.store.deleteStrokes(op.ids);
        this.ops.shift();
        this.persist();
        delay = 0;
      } catch (err) {
        if (err instanceof StoreError && err.permanent) {
          console.error('Dropping unsavable change:', err.message);
          this.ops.shift();
          this.persist();
          continue;
        }
        console.warn('Save failed, will retry:', err);
        delay = Math.min(30000, delay ? delay * 2 : 2000);
        this.setState('retrying');
        await this.sleep(delay);
      }
    }
    this.running = false;
    this.setState('saved');
  }
}
