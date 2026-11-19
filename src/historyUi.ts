import type { Board } from './board';
import { contentHash, diff, fromSnap, IDLE_MS, MAX_WAIT_MS, restorePlan, toPrune, toSnap, type SnapStroke, type VersionKind, type VersionMeta } from './history';
import { icons } from './icons';
import type { Store } from './store/store';
import { StoreError } from './store/store';
import type { NoteMeta, Stroke } from './types';
import { dialog, h, lsGet, lsSet, toast, uuid } from './util';

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
    const run = async (): Promise<VersionMeta | null> => {
      if (!(await this.enabled)) return null;
      const startedAt = this.changes.get(noteId) ?? 0;
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

/** What the History panel needs from the app. */
export interface HistoryHost {
  store: Store;
  board: Board;
  recorder: VersionRecorder;
  /** Turn the rest of the app off (or back on) while history is open. */
  setBusy(on: boolean): void;
  /** Change the note's strokes as one undoable step. */
  replaceStrokes(remove: Stroke[], add: Stroke[]): void;
  /** Make a new note next to `source` with these strokes; returns it, not yet opened. */
  createNote(source: NoteMeta, title: string, strokes: Stroke[]): Promise<NoteMeta>;
  openNote(n: NoteMeta): Promise<void>;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const whenFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return dayFmt.format(d);
}

/** One row of the list: the note as it is now, or a saved version. */
type Entry = { current: true } | { current: false; v: VersionMeta };

/**
 * Version history of the open note: a panel listing its versions, newest first, grouped by day.
 * Picking one shows it on the board, read-only, with what changed since the version before it
 * marked. From there: restore it, make a copy, or name it.
 */
export class HistoryPanel {
  private el: HTMLElement;
  private list: HTMLElement;
  private actions: HTMLElement;
  private versions: VersionMeta[] = [];
  private selected: Entry = { current: true };
  private snaps = new Map<string, Promise<SnapStroke[]>>();
  private showChanges = lsGet('lb-history-changes', true);
  private namedOnly = false;
  private token = 0;
  private busy = false;
  private closed = false;
  private offKeys: () => void;

  constructor(
    private host: HistoryHost,
    private note: NoteMeta,
    parent: HTMLElement,
    private onClosed: () => void,
  ) {
    const changes = h('input', { type: 'checkbox' }) as HTMLInputElement;
    changes.checked = this.showChanges;
    changes.addEventListener('change', () => {
      this.showChanges = changes.checked;
      lsSet('lb-history-changes', this.showChanges);
      void this.show();
    });
    const named = h('input', { type: 'checkbox' }) as HTMLInputElement;
    named.addEventListener('change', () => {
      this.namedOnly = named.checked;
      this.render();
    });
    const close = h('button', { class: 'icon-btn', type: 'button', title: 'Close version history', 'aria-label': 'Close version history' });
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.close());
    this.list = h('div', { class: 'history-list', role: 'listbox', 'aria-label': 'Versions' });
    this.actions = h('div', { class: 'history-actions' });
    this.el = h(
      'aside',
      { class: 'history-panel', 'aria-label': 'Version history' },
      h('div', { class: 'history-head' }, h('div', {}, h('h2', {}, 'Version history'), h('div', { class: 'history-note' }, note.title || 'Untitled')), close),
      h('div', { class: 'history-options' }, h('label', {}, changes, h('span', {}, 'Highlight changes')), h('label', {}, named, h('span', {}, 'Only named versions'))),
      this.list,
      h('p', { class: 'history-legend' }, h('span', { class: 'added' }, 'New'), ' ', h('span', { class: 'removed' }, 'Removed'), ' since the version before.'),
      this.actions,
    );
    parent.append(this.el);
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        this.close();
      }
    };
    window.addEventListener('keydown', keys);
    this.offKeys = () => window.removeEventListener('keydown', keys);
    host.setBusy(true);
    host.recorder.onChange = (id) => {
      if (id === this.note.id) void this.reload();
    };
    void this.reload();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.offKeys();
    this.host.recorder.onChange = () => {};
    this.host.board.endPreview();
    this.host.setBusy(false);
    this.el.remove();
    this.onClosed();
  }

  private async reload() {
    try {
      this.versions = await this.host.store.listVersions(this.note.id);
    } catch (e) {
      toast('Could not load the history: ' + (e as Error).message, 'error');
      this.versions = [];
    }
    if (this.closed) return;
    const sel = this.selected;
    if (!sel.current && !this.versions.some((v) => v.id === sel.v.id)) this.selected = { current: true };
    this.render();
    await this.show();
  }

  /** The note as it is now differs from its newest version (or it has none). */
  private async currentIsNew() {
    if (!this.versions.length) return true;
    const live = this.host.board.allStrokes().map(toSnap);
    const newest = await this.snap(this.versions[0]).catch(() => null);
    if (!newest) return this.host.recorder.isDirty(this.note.id);
    const d = diff(newest, live);
    return d.added.size > 0 || d.removed.length > 0;
  }

  private render() {
    const rows: HTMLElement[] = [];
    let day = '';
    const entries: Entry[] = [{ current: true }, ...this.versions.filter((v) => !this.namedOnly || v.name).map((v) => ({ current: false as const, v }))];
    for (const e of entries) {
      if (!e.current) {
        const d = dayLabel(e.v.created_at);
        if (d !== day) {
          day = d;
          rows.push(h('div', { class: 'history-day' }, d));
        }
      }
      const on = e.current ? this.selected.current : !this.selected.current && this.selected.v.id === e.v.id;
      const title = e.current ? 'Current version' : e.v.name || timeFmt.format(new Date(e.v.created_at));
      const sub = e.current
        ? 'What the note looks like now'
        : [e.v.name ? whenFmt.format(new Date(e.v.created_at)) : null, e.v.kind === 'restore' && e.v.restored_from ? `Restored from ${whenFmt.format(new Date(e.v.restored_from))}` : null].filter(Boolean).join(' · ');
      const b = h('button', { class: 'history-item' + (on ? ' active' : '') + (!e.current && e.v.name ? ' named' : ''), type: 'button', role: 'option', 'aria-selected': String(on) }, h('span', { class: 'history-title' }, title), sub ? h('span', { class: 'history-sub' }, sub) : null);
      b.addEventListener('click', () => {
        this.selected = e;
        this.render();
        void this.show();
      });
      rows.push(b);
    }
    if (!this.versions.length) rows.push(h('p', { class: 'history-empty' }, 'No earlier versions yet. Versions are saved as you write: a couple of minutes after you pause, and when you leave the note.'));
    this.list.replaceChildren(...rows);
    this.renderActions();
  }

  private renderActions() {
    const btn = (label: string, cls: string, fn: () => Promise<void>) => {
      const b = h('button', { class: 'btn ' + cls, type: 'button' }, label) as HTMLButtonElement;
      b.disabled = this.busy;
      b.addEventListener('click', () => void this.run(fn));
      return b;
    };
    const sel = this.selected;
    this.actions.replaceChildren(
      ...(sel.current
        ? [btn('Name current version', '', () => this.nameCurrent()), btn('Make a copy', '', () => this.copy())]
        : [
            btn('Restore this version', 'primary', () => this.restore(sel.v)),
            btn('Make a copy', '', () => this.copy(sel.v)),
            btn(sel.v.name ? 'Rename' : 'Name this version', '', () => this.rename(sel.v)),
            ...(sel.v.name ? [btn('Remove name', '', () => this.unname(sel.v))] : []),
          ]),
    );
  }

  private async run(fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.renderActions();
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      this.busy = false;
      if (!this.closed) this.renderActions();
    }
  }

  private snap(v: VersionMeta): Promise<SnapStroke[]> {
    let p = this.snaps.get(v.id);
    if (!p) {
      p = this.host.store.loadVersion(v);
      p.catch(() => this.snaps.delete(v.id));
      this.snaps.set(v.id, p);
    }
    return p;
  }

  /** The version before `v` in the whole history (null: none). */
  private before(v: VersionMeta | null): VersionMeta | null {
    const i = v ? this.versions.findIndex((x) => x.id === v.id) : -1;
    return this.versions[i + 1] ?? null;
  }

  /** Show the selected entry on the board. */
  private async show() {
    const token = ++this.token;
    const sel = this.selected;
    const board = this.host.board;
    if (sel.current) {
      const live = board.allStrokes();
      const base = this.versions[0];
      const prev = this.showChanges && base ? await this.snap(base).catch(() => null) : null;
      if (token !== this.token || this.closed) return;
      if (!prev) return board.showPreview(live.map((s) => ({ s, mark: null })));
      const d = diff(prev, live.map(toSnap));
      board.showPreview([...live.map((s, i) => ({ s, mark: d.added.has(i) ? ('added' as const) : null })), ...d.removed.map((r) => ({ s: fromSnap(r, this.note.id, uuid()), mark: 'removed' as const }))]);
      return;
    }
    this.list.setAttribute('aria-busy', 'true');
    try {
      const strokes = await this.snap(sel.v);
      const prevV = this.showChanges ? this.before(sel.v) : null;
      const prev = prevV ? await this.snap(prevV).catch(() => null) : null;
      if (token !== this.token || this.closed) return;
      const mine = strokes.map((s) => fromSnap(s, this.note.id, uuid()));
      if (!prev || !this.showChanges) {
        board.showPreview(mine.map((s) => ({ s, mark: this.showChanges && !prevV ? ('added' as const) : null })));
      } else {
        const d = diff(prev, strokes);
        board.showPreview([...mine.map((s, i) => ({ s, mark: d.added.has(i) ? ('added' as const) : null })), ...d.removed.map((r) => ({ s: fromSnap(r, this.note.id, uuid()), mark: 'removed' as const }))]);
      }
    } catch (e) {
      if (token === this.token) toast('Could not open this version: ' + (e as Error).message, 'error');
    } finally {
      if (token === this.token) this.list.removeAttribute('aria-busy');
    }
  }

  private async restore(v: VersionMeta) {
    const when = whenFmt.format(new Date(v.created_at));
    const ok = await dialog({
      title: 'Restore this version?',
      message: `The note goes back to how it was ${v.name ? `in "${v.name}" (${when})` : `on ${when}`}. Nothing is lost: how it is now stays in the history, and you can undo the restore.`,
      ok: 'Restore',
    });
    if (!ok) return;
    const target = await this.snap(v);
    const recorder = this.host.recorder;
    const live = this.host.board.allStrokes();
    // Keep the current state in the history first, if it is not there yet.
    if (await this.currentIsNew()) await recorder.save(this.note.id, { strokes: live.map(toSnap) });
    const plan = restorePlan(live, target);
    this.close();
    this.host.replaceStrokes(
      plan.remove,
      plan.add.map((s) => fromSnap(s, this.note.id, uuid())),
    );
    await recorder.save(this.note.id, { strokes: target, kind: 'restore', restoredFrom: v.created_at, force: true });
    toast(`Restored the version from ${when}.`);
  }

  private async copy(v?: VersionMeta) {
    const when = v ? whenFmt.format(new Date(v.created_at)) : null;
    const keep = { label: v ? 'Keep the history up to this version' : 'Keep the history', value: false, hint: 'Otherwise the copy starts with no earlier versions.' };
    const title = await dialog({ title: v ? 'Copy this version' : 'Copy this note', message: v ? `A new note with the content from ${when}.` : 'A new note with the same content.', input: `${this.note.title || 'Untitled'} (copy)`, ok: 'Make a copy', check: keep });
    if (title === null) return;
    const strokes = v ? await this.snap(v) : this.host.board.allStrokes().map(toSnap);
    const copy = await this.host.createNote(this.note, title.trim().slice(0, 200) || 'Untitled', strokes.map((s) => fromSnap(s, '', uuid())));
    if (keep.value) {
      // The versions up to this one (or all), oldest first, with their dates.
      const from = v ? this.versions.findIndex((x) => x.id === v.id) : 0;
      const older = this.versions.slice(Math.max(0, from)).reverse();
      for (const [i, o] of older.entries()) {
        if (older.length > 5) toast(`Copying history... ${i + 1} of ${older.length}`);
        await this.host.store.saveVersion({ ...o, id: uuid(), note_id: copy.id }, await this.snap(o));
      }
      if (older.length) await this.host.recorder.remember(copy.id, strokes);
      if (!v && (await this.currentIsNew())) await this.host.recorder.save(copy.id, { strokes });
    }
    this.close();
    await this.host.openNote(copy);
    toast(keep.value ? 'Copied, with its history.' : 'Copied.');
  }

  private async nameCurrent() {
    const name = await dialog({ title: 'Name current version', input: '', ok: 'Save' });
    if (!name?.trim()) return;
    const n = name.trim().slice(0, 120);
    // Unchanged since the newest version: name that one (as with saving a name for "now").
    if (this.versions.length && !(await this.currentIsNew())) {
      await this.host.store.renameVersion(this.versions[0], n);
      await this.reload();
      return;
    }
    await this.host.recorder.save(this.note.id, { strokes: this.host.board.allStrokes().map(toSnap), name: n, force: true });
  }

  private async rename(v: VersionMeta) {
    const name = await dialog({ title: v.name ? 'Rename version' : 'Name this version', message: 'Named versions are kept until you remove the name.', input: v.name ?? '', ok: 'Save' });
    if (name === null) return;
    await this.host.store.renameVersion(v, name.trim().slice(0, 120) || null);
    await this.reload();
  }

  private async unname(v: VersionMeta) {
    await this.host.store.renameVersion(v, null);
    await this.reload();
  }
}
