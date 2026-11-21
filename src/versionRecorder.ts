import { contentHash, IDLE_MS, MAX_WAIT_MS, toPrune, toSnap, type SnapStroke, type VersionKind, type VersionMeta } from './history';
import type { Store } from './store/store';
import { StoreError } from './store/store';
import type { Stroke } from './types';
import { lsGet, lsSet, toast, uuid } from './util';

/** Shown when the cloud database does not have version history yet. */
export const HISTORY_NEEDS_UPDATE = 'Version history needs a database update: the site operator re-runs supabase/schema.sql.';

interface RecorderState {
  /** Notes changed since their last version: when the first change was made. */
  dirty: Record<string, string>;
  /** Fingerprint of each note's newest version (recent notes only), to skip saving duplicates. */
  hash: Record<string, string>;
}
const HASHES_KEPT = 300;

/**
 * Saves versions on its own: after writing pauses for a couple of minutes, at least every ten
 * minutes while writing goes on, and when you leave a note. Which notes have changes not in their
 * history yet is kept on the device, so a reload or closed tab still gets its version later (the
 * next time the note is opened, or when the app starts).
 */
export class VersionRecorder {
  private state: RecorderState;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Counts changes per note, so a save does not clear a change made while it was running. */
  private changes = new Map<string, number>();
  /** One save at a time per note. */
  private chains = new Map<string, Promise<unknown>>();
  /** Notes checked for a first version this session. */
  private checked = new Set<string>();
  private stopped = false;
  private warned = false;
  readonly enabled: Promise<boolean>;
  /** A version was saved or removed (the History panel refreshes). */
  onChange: (noteId: string) => void = () => {};

  constructor(
    private store: Store,
    private key: string,
    /** A note's current strokes; null while they cannot be known (still loading). */
    private strokesOf: (noteId: string) => Promise<Stroke[] | null>,
  ) {
    this.state = { dirty: {}, hash: {}, ...lsGet<Partial<RecorderState>>(key, {}) };
    this.enabled = (store.supportsHistory?.() ?? Promise.resolve(true)).catch(() => false);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private persist() {
    const keys = Object.keys(this.state.hash);
    if (keys.length > HASHES_KEPT) for (const k of keys.slice(0, keys.length - HASHES_KEPT)) delete this.state.hash[k];
    lsSet(this.key, this.state);
  }

  isDirty(noteId: string) {
    return noteId in this.state.dirty;
  }

  /** The note changed: save a version once writing pauses (or after ten minutes of writing). */
  changed(noteId: string) {
    if (this.stopped) return;
    this.changes.set(noteId, (this.changes.get(noteId) ?? 0) + 1);
    const first = this.state.dirty[noteId];
    if (!first) {
      this.state.dirty[noteId] = new Date().toISOString();
      this.persist();
    }
    const waited = first ? Date.now() - Date.parse(first) : 0;
    this.schedule(noteId, waited >= MAX_WAIT_MS ? 0 : Math.min(IDLE_MS, MAX_WAIT_MS - waited));
  }

  private schedule(noteId: string, ms: number) {
    clearTimeout(this.timers.get(noteId));
    this.timers.set(
      noteId,
      setTimeout(() => {
        this.timers.delete(noteId);
        void this.save(noteId).catch(() => {});
      }, ms),
    );
  }

  /** Leaving a note: save its changes now (from the strokes it had on screen). */
  leave(noteId: string, strokes: Stroke[]) {
    if (!this.isDirty(noteId)) return;
    clearTimeout(this.timers.get(noteId));
    this.timers.delete(noteId);
    const snap = strokes.map(toSnap);
    void this.save(noteId, { strokes: snap }).catch(() => {});
  }

  /**
   * A note was opened with these strokes. A note that has ink but no history yet (made before
   * history existed, or imported) gets its first version, so later changes can be compared with
   * it; one with changes left from an earlier visit gets their version now.
   */
  async opened(noteId: string, strokes: Stroke[]) {
    if (this.stopped || !(await this.enabled)) return;
    if (this.isDirty(noteId)) return void this.save(noteId, { strokes: strokes.map(toSnap) }).catch(() => {});
    if (this.checked.has(noteId) || !strokes.length) return;
    this.checked.add(noteId);
    try {
      if (!(await this.store.listVersions(noteId)).length) await this.save(noteId, { strokes: strokes.map(toSnap), force: true });
    } catch (e) {
      console.warn('History not checked', e);
    }
  }

  /** At start: save versions for notes changed in an earlier visit, other than `except`. */
  async catchUp(except: string | null, exists: (noteId: string) => boolean) {
    if (!(await this.enabled)) return;
    for (const id of Object.keys(this.state.dirty)) {
      if (id === except) continue;
      if (!exists(id)) {
        this.forget(id);
        continue;
      }
      await this.save(id).catch(() => {});
    }
  }

  /** The note was deleted. */
  forget(noteId: string) {
    clearTimeout(this.timers.get(noteId));
    this.timers.delete(noteId);
    delete this.state.dirty[noteId];
    delete this.state.hash[noteId];
    this.persist();
  }

  /** Remember a note's newest content (after a copy brought its history along). */
  async remember(noteId: string, strokes: SnapStroke[]) {
    this.state.hash[noteId] = await contentHash(strokes);
    this.persist();
  }

  /**
   * Save a version of the note now. Skipped (null) when the content is the same as the newest
   * version, unless `force` (a restore always adds its version, a name always gets one).
   */
  save(noteId: string, opts: { strokes?: SnapStroke[]; kind?: VersionKind; name?: string | null; restoredFrom?: string | null; force?: boolean } = {}): Promise<VersionMeta | null> {
    // With strokes given, the snapshot is of now: changes after this call are not in it, even if the
    // save waits behind another one.
    const calledAt = this.changes.get(noteId) ?? 0;
    const run = async (): Promise<VersionMeta | null> => {
      if (!(await this.enabled)) return null;
      const startedAt = opts.strokes ? calledAt : (this.changes.get(noteId) ?? 0);
      let snap = opts.strokes;
      if (!snap) {
        const live = await this.strokesOf(noteId);
        if (!live) {
          this.schedule(noteId, IDLE_MS);
          return null;
        }
        snap = live.map(toSnap);
      }
      const hash = await contentHash(snap);
      const clean = () => {
        if ((this.changes.get(noteId) ?? 0) === startedAt) delete this.state.dirty[noteId];
        this.state.hash[noteId] = hash;
        this.persist();
      };
      if (!opts.force && this.state.hash[noteId] === hash) {
        clean();
        return null;
      }
      const v: VersionMeta = { id: uuid(), note_id: noteId, created_at: new Date().toISOString(), kind: opts.kind ?? 'auto', name: opts.name ?? null, restored_from: opts.restoredFrom ?? null };
      try {
        await this.store.saveVersion(v, snap);
      } catch (e) {
        // Kept as changed: tried again after the next pause. A limit is said once.
        if (e instanceof StoreError && e.permanent && !this.warned) {
          this.warned = true;
          toast('Version not saved: ' + e.message, 'error');
        } else console.warn('Version not saved, will retry', e);
        if (!this.stopped && this.isDirty(noteId)) this.schedule(noteId, IDLE_MS);
        throw e;
      }
      clean();
      await this.prune(noteId).catch((e) => console.warn('Old versions not tidied', e));
      this.onChange(noteId);
      return v;
    };
    const next = (this.chains.get(noteId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.chains.set(noteId, next);
    return next;
  }

  private async prune(noteId: string) {
    const gone = toPrune(await this.store.listVersions(noteId));
    if (gone.length) await this.store.deleteVersions(gone.map((v) => v.id));
  }
}
