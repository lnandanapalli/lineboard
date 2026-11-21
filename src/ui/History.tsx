import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Board } from '../board';
import { diff, fromSnap, restorePlan, toSnap, type SnapStroke, type VersionMeta } from '../history';
import { icons } from '../icons';
import type { Store } from '../store/store';
import type { NoteMeta, Stroke } from '../types';
import { dialog, lsGet, lsSet, toast, uuid } from '../util';
import { clip, MAX_NOTE_TITLE, MAX_VERSION_NAME } from '../limits';
import type { VersionRecorder } from '../versionRecorder';
import { Svg } from './Icon';

/** Shown when the cloud database does not have version history yet. */
export const HISTORY_NEEDS_UPDATE = 'Version history needs a database update: the site operator re-runs supabase/schema.sql.';

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

interface HistoryState {
  versions: VersionMeta[];
  selected: Entry;
  showChanges: boolean;
  namedOnly: boolean;
  /** An action is running: the buttons wait. */
  busy: boolean;
  /** A version is being opened. */
  loading: boolean;
}

/**
 * Version history of the open note: a panel listing its versions, newest first, grouped by day.
 * Picking one shows it on the board, read-only, with what changed since the version before it
 * marked. From there: restore it, make a copy, or name it. This object does the work; HistoryView
 * draws it.
 */
export class HistoryPanel {
  readonly state = createStore<HistoryState>(() => ({
    versions: [],
    selected: { current: true },
    showChanges: lsGet('lb-history-changes', true),
    namedOnly: false,
    busy: false,
    loading: false,
  }));
  private snaps = new Map<string, Promise<SnapStroke[]>>();
  private token = 0;
  private closed = false;
  private offKeys: () => void;

  constructor(
    private host: HistoryHost,
    readonly note: NoteMeta,
    private onClosed: () => void,
  ) {
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

  private get s() {
    return this.state.getState();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.offKeys();
    this.host.recorder.onChange = () => {};
    this.host.board.endPreview();
    this.host.setBusy(false);
    this.onClosed();
  }

  setShowChanges(on: boolean) {
    lsSet('lb-history-changes', on);
    this.state.setState({ showChanges: on });
    void this.show();
  }

  setNamedOnly(on: boolean) {
    this.state.setState({ namedOnly: on });
  }

  select(e: Entry) {
    this.state.setState({ selected: e });
    void this.show();
  }

  private async reload() {
    let versions: VersionMeta[];
    try {
      versions = await this.host.store.listVersions(this.note.id);
    } catch (e) {
      toast('Could not load the history: ' + (e as Error).message, 'error');
      versions = [];
    }
    if (this.closed) return;
    const sel = this.s.selected;
    this.state.setState({ versions, ...(!sel.current && !versions.some((v) => v.id === sel.v.id) ? { selected: { current: true } } : {}) });
    await this.show();
  }

  /** The note as it is now differs from its newest version (or it has none). */
  private async currentIsNew() {
    const versions = this.s.versions;
    if (!versions.length) return true;
    const live = this.host.board.allStrokes().map(toSnap);
    const newest = await this.snap(versions[0]).catch(() => null);
    if (!newest) return this.host.recorder.isDirty(this.note.id);
    const d = diff(newest, live);
    return d.added.size > 0 || d.removed.length > 0;
  }

  async run(fn: () => Promise<void>) {
    if (this.s.busy) return;
    this.state.setState({ busy: true });
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      if (!this.closed) this.state.setState({ busy: false });
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
    const versions = this.s.versions;
    const i = v ? versions.findIndex((x) => x.id === v.id) : -1;
    return versions[i + 1] ?? null;
  }

  /** Show the selected entry on the board. */
  private async show() {
    const token = ++this.token;
    const { selected: sel, showChanges, versions } = this.s;
    const board = this.host.board;
    if (sel.current) {
      const live = board.allStrokes();
      const base = versions[0];
      const prev = showChanges && base ? await this.snap(base).catch(() => null) : null;
      if (token !== this.token || this.closed) return;
      if (!prev) return board.showPreview(live.map((s) => ({ s, mark: null })));
      const d = diff(prev, live.map(toSnap));
      board.showPreview([...live.map((s, i) => ({ s, mark: d.added.has(i) ? ('added' as const) : null })), ...d.removed.map((r) => ({ s: fromSnap(r, this.note.id, uuid()), mark: 'removed' as const }))]);
      return;
    }
    this.state.setState({ loading: true });
    try {
      const strokes = await this.snap(sel.v);
      const prevV = showChanges ? this.before(sel.v) : null;
      const prev = prevV ? await this.snap(prevV).catch(() => null) : null;
      if (token !== this.token || this.closed) return;
      const mine = strokes.map((s) => fromSnap(s, this.note.id, uuid()));
      if (!prev || !showChanges) {
        board.showPreview(mine.map((s) => ({ s, mark: showChanges && !prevV ? ('added' as const) : null })));
      } else {
        const d = diff(prev, strokes);
        board.showPreview([...mine.map((s, i) => ({ s, mark: d.added.has(i) ? ('added' as const) : null })), ...d.removed.map((r) => ({ s: fromSnap(r, this.note.id, uuid()), mark: 'removed' as const }))]);
      }
    } catch (e) {
      if (token === this.token) toast('Could not open this version: ' + (e as Error).message, 'error');
    } finally {
      if (token === this.token && !this.closed) this.state.setState({ loading: false });
    }
  }

  async restore(v: VersionMeta) {
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

  async copy(v?: VersionMeta) {
    const when = v ? whenFmt.format(new Date(v.created_at)) : null;
    const keep = { label: v ? 'Keep the history up to this version' : 'Keep the history', value: false, hint: 'Otherwise the copy starts with no earlier versions.' };
    const title = await dialog({ title: v ? 'Copy this version' : 'Copy this note', message: v ? `A new note with the content from ${when}.` : 'A new note with the same content.', input: clip(`${this.note.title || 'Untitled'} (copy)`, MAX_NOTE_TITLE), ok: 'Make a copy', check: keep, maxLength: MAX_NOTE_TITLE });
    if (title === null) return;
    const strokes = v ? await this.snap(v) : this.host.board.allStrokes().map(toSnap);
    const copy = await this.host.createNote(this.note, clip(title, MAX_NOTE_TITLE) || 'Untitled', strokes.map((s) => fromSnap(s, '', uuid())));
    if (keep.value) {
      // The versions up to this one (or all), oldest first, with their dates.
      const versions = this.s.versions;
      const from = v ? versions.findIndex((x) => x.id === v.id) : 0;
      const older = versions.slice(Math.max(0, from)).reverse();
      for (const [i, o] of older.entries()) {
        if (older.length > 5) toast(`Copying history... ${i + 1} of ${older.length}`);
        await this.host.store.saveVersion({ ...o, id: uuid(), note_id: copy.id }, await this.snap(o));
      }
      // The newest version copied is what the copy's history ends with; the note as it is now joins it
      // when it differs from that.
      if (older.length) await this.host.recorder.remember(copy.id, await this.snap(older[older.length - 1]));
      if (!v && (await this.currentIsNew())) await this.host.recorder.save(copy.id, { strokes });
    }
    this.close();
    await this.host.openNote(copy);
    toast(keep.value ? 'Copied, with its history.' : 'Copied.');
  }

  async nameCurrent() {
    const name = await dialog({ title: 'Name current version', input: '', ok: 'Save', maxLength: MAX_VERSION_NAME });
    if (!name?.trim()) return;
    const n = clip(name, MAX_VERSION_NAME);
    // Unchanged since the newest version: name that one (as with saving a name for "now").
    const versions = this.s.versions;
    if (versions.length && !(await this.currentIsNew())) {
      await this.host.store.renameVersion(versions[0], n);
      await this.reload();
      return;
    }
    await this.host.recorder.save(this.note.id, { strokes: this.host.board.allStrokes().map(toSnap), name: n, force: true });
  }

  async rename(v: VersionMeta) {
    const name = await dialog({ title: v.name ? 'Rename version' : 'Name this version', message: 'Named versions are kept until you remove the name.', input: v.name ?? '', ok: 'Save', maxLength: MAX_VERSION_NAME });
    if (name === null) return;
    await this.host.store.renameVersion(v, clip(name, MAX_VERSION_NAME) || null);
    await this.reload();
  }

  async unname(v: VersionMeta) {
    await this.host.store.renameVersion(v, null);
    await this.reload();
  }
}

/** The version history panel, beside the board. */
export function HistoryView({ panel }: { panel: HistoryPanel }) {
  const { versions, selected, showChanges, namedOnly, busy, loading } = useStore(panel.state);
  const entries: Entry[] = [{ current: true }, ...versions.filter((v) => !namedOnly || v.name).map((v) => ({ current: false as const, v }))];
  const rows: React.ReactNode[] = [];
  let day = '';
  for (const e of entries) {
    if (!e.current) {
      const d = dayLabel(e.v.created_at);
      if (d !== day) {
        day = d;
        rows.push(
          <div key={'day-' + d} className="history-day">
            {d}
          </div>,
        );
      }
    }
    const on = e.current ? selected.current : !selected.current && selected.v.id === e.v.id;
    const title = e.current ? 'Current version' : e.v.name || timeFmt.format(new Date(e.v.created_at));
    const sub = e.current
      ? 'What the note looks like now'
      : [e.v.name ? whenFmt.format(new Date(e.v.created_at)) : null, e.v.kind === 'restore' && e.v.restored_from ? `Restored from ${whenFmt.format(new Date(e.v.restored_from))}` : null].filter(Boolean).join(' · ');
    rows.push(
      <button key={e.current ? 'current' : e.v.id} className={'history-item' + (on ? ' active' : '') + (!e.current && e.v.name ? ' named' : '')} type="button" role="option" aria-selected={on} onClick={() => panel.select(e)}>
        <span className="history-title">{title}</span>
        {sub && <span className="history-sub">{sub}</span>}
      </button>,
    );
  }
  const btn = (label: string, cls: string, fn: () => Promise<void>) => (
    <button key={label} className={'btn ' + cls} type="button" disabled={busy} onClick={() => void panel.run(fn)}>
      {label}
    </button>
  );
  const sel = selected;
  return (
    <aside className="history-panel" aria-label="Version history">
      <div className="history-head">
        <div>
          <h2>Version history</h2>
          <div className="history-note">{panel.note.title || 'Untitled'}</div>
        </div>
        <button className="icon-btn" type="button" title="Close version history" aria-label="Close version history" onClick={() => panel.close()}>
          <Svg icon={icons.close} />
        </button>
      </div>
      <div className="history-options">
        <label>
          <input type="checkbox" checked={showChanges} onChange={(e) => panel.setShowChanges(e.target.checked)} />
          <span>Highlight changes</span>
        </label>
        <label>
          <input type="checkbox" checked={namedOnly} onChange={(e) => panel.setNamedOnly(e.target.checked)} />
          <span>Only named versions</span>
        </label>
      </div>
      <div className="history-list" role="listbox" aria-label="Versions" aria-busy={loading || undefined}>
        {rows}
        {!versions.length && <p className="history-empty">No earlier versions yet. Versions are saved as you write: a couple of minutes after you pause, and when you leave the note.</p>}
      </div>
      <p className="history-legend">
        <span className="added">New</span> <span className="removed">Removed</span> since the version before.
      </p>
      <div className="history-actions">
        {sel.current
          ? [btn('Name current version', '', () => panel.nameCurrent()), btn('Make a copy', '', () => panel.copy())]
          : [
              btn('Restore this version', 'primary', () => panel.restore(sel.v)),
              btn('Make a copy', '', () => panel.copy(sel.v)),
              btn(sel.v.name ? 'Rename' : 'Name this version', '', () => panel.rename(sel.v)),
              ...(sel.v.name ? [btn('Remove name', '', () => panel.unname(sel.v))] : []),
            ]}
      </div>
    </aside>
  );
}
