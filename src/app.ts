import { Board, PAGE_W } from './board';
import { icons } from './icons';
import { logo } from './auth';
import type { Store } from './store/store';
import { SyncQueue, type SyncState } from './sync';
import { DEFAULT_SETTINGS, type AppUser, type NoteMeta, type Settings, type Stroke, type Tool } from './types';
import { debounce, dialog, h, lsGet, lsSet, toast } from './util';

const PEN_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'];
const PEN_WIDTHS = [2, 3.5, 6];
const HL_WIDTHS = [14, 22, 32];

type Action = { type: 'add' | 'remove'; strokes: Stroke[] };

export class App {
  private settings: Settings;
  private board!: Board;
  private queue: SyncQueue;
  private notes: NoteMeta[] = [];
  private current: NoteMeta | null = null;
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  private tool: Tool = 'pen';
  private loadToken = 0;
  private abort = new AbortController();

  // DOM
  private root: HTMLElement;
  private sidebar!: HTMLElement;
  private noteList!: HTMLElement;
  private titleInput!: HTMLInputElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private swatches!: HTMLElement;
  private widths!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private multiBtn!: HTMLButtonElement;
  private status!: HTMLElement;
  private settingsDlg!: HTMLDialogElement;
  private contactReadout!: HTMLElement;
  private hint!: HTMLElement;

  private saveSettingsDebounced = debounce(() => {
    this.store.saveSettings(this.settings).catch((e) => console.warn('Settings not saved', e));
  }, 800);

  constructor(
    root: HTMLElement,
    private store: Store,
    private user: AppUser,
    private signOut: (() => Promise<void>) | null,
  ) {
    this.root = root;
    this.settings = { ...DEFAULT_SETTINGS, ...lsGet<Partial<Settings>>(this.lsKey('settings'), {}) };
    this.queue = new SyncQueue(store, this.lsKey('queue'));
    this.queue.onState = (s) => this.renderStatus(s);
    this.build();
    this.renderStatus(this.queue.pending ? 'saving' : 'saved');
    window.addEventListener(
      'beforeunload',
      (e) => {
        if (this.queue.pending) {
          e.preventDefault();
          e.returnValue = '';
        }
      },
      { signal: this.abort.signal },
    );
    void this.init();
  }

  /** Tear down before switching user. */
  destroy() {
    this.abort.abort();
    this.settingsDlg.remove();
  }

  private lsKey(k: string) {
    return `lb-${k}-${this.user.id}`;
  }

  private async init() {
    try {
      const remote = await this.store.loadSettings();
      if (remote) {
        this.settings = { ...DEFAULT_SETTINGS, ...remote };
        lsSet(this.lsKey('settings'), this.settings);
        this.board.updateSettings(this.settings);
        this.renderToolOptions();
      }
    } catch (e) {
      console.warn('Could not load settings', e);
    }
    await this.refreshNotes();
    const lastId = lsGet<string | null>(this.lsKey('last-note'), null);
    const target = this.notes.find((n) => n.id === lastId) ?? this.notes[0];
    if (target) await this.openNote(target);
    else await this.newNote();
  }

  // ----------------------------- layout -----------------------------

  private iconBtn(icon: string, title: string, onClick: () => void, cls = '') {
    const b = h('button', { class: 'icon-btn ' + cls, type: 'button', title, 'aria-label': title }) as HTMLButtonElement;
    b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  }

  private build() {
    // Toolbar
    this.titleInput = h('input', { class: 'title-input', type: 'text', 'aria-label': 'Note title', maxlength: '120' }) as HTMLInputElement;
    this.titleInput.addEventListener('change', () => void this.renameCurrent(this.titleInput.value));
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.titleInput.blur();
    });

    const tools = h('div', { class: 'group' });
    for (const [t, icon, label] of [
      ['pen', icons.pen, 'Pen'],
      ['highlighter', icons.highlighter, 'Highlighter'],
      ['eraser', icons.eraser, 'Eraser'],
    ] as const) {
      const b = this.iconBtn(icon, label, () => this.setTool(t), 'tool');
      this.toolBtns.set(t, b);
      tools.append(b);
    }
    this.swatches = h('div', { class: 'group swatches' });
    this.widths = h('div', { class: 'group widths' });

    this.undoBtn = this.iconBtn(icons.undo, 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = this.iconBtn(icons.redo, 'Redo (Ctrl+Shift+Z)', () => this.redo());

    this.multiBtn = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-checked': 'false', title: 'Unlock several strips at once' }) as HTMLButtonElement;
    this.multiBtn.innerHTML = `${icons.multi}<span>Multi-strip</span><i class="knob"></i>`;
    this.multiBtn.addEventListener('click', () => this.setMulti(!this.board.isMulti()));

    this.status = h('div', { class: 'status', title: '' });

    const toolbar = h(
      'header',
      { class: 'toolbar' },
      this.iconBtn(icons.menu, 'Notes', () => this.toggleSidebar()),
      this.titleInput,
      h('div', { class: 'sep' }),
      tools,
      this.swatches,
      this.widths,
      h('div', { class: 'sep' }),
      h('div', { class: 'group' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'sep' }),
      this.multiBtn,
      h(
        'div',
        { class: 'group' },
        this.iconBtn(icons.up, 'Previous strip (Up arrow)', () => this.board.stepLine(-1)),
        this.iconBtn(icons.down, 'Next strip (Down arrow)', () => this.board.stepLine(1)),
        this.iconBtn(icons.lockAll, 'Lock all strips', () => this.board.lockAll()),
      ),
      h('div', { class: 'spacer' }),
      this.status,
      this.iconBtn(icons.download, 'Export as PNG', () => void this.exportPNG()),
      this.iconBtn(icons.gear, 'Settings', () => this.openSettings()),
    );

    // Sidebar
    this.noteList = h('ul', { class: 'note-list' });
    const newBtn = h('button', { class: 'btn primary', type: 'button' });
    newBtn.innerHTML = `${icons.plus}<span>New note</span>`;
    newBtn.addEventListener('click', () => void this.newNote());
    this.sidebar = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'sidebar-head' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')), this.iconBtn(icons.close, 'Close', () => this.toggleSidebar(false))),
      newBtn,
      this.noteList,
      h('div', { class: 'sidebar-foot' }, this.store.mode === 'local' ? 'Local mode: notes stay on this device.' : this.user.email ?? ''),
    );
    const scrim = h('div', { class: 'scrim' });
    scrim.addEventListener('click', () => this.toggleSidebar(false));

    // Board
    const boardHost = h('div', { class: 'board-host' });
    this.hint = h('div', { class: 'hint' });
    this.hint.innerHTML =
      '<b>How it works:</b> tap a 🔒 in the margin to unlock one strip. Only that strip takes ink, so rest your palm anywhere else. Drag the margin to scroll. <button type="button" class="link">Got it</button>';
    this.hint.querySelector('button')!.addEventListener('click', () => {
      this.hint.remove();
      lsSet('lb-hint-dismissed', true);
    });

    const main = h('div', { class: 'main' }, this.sidebar, scrim, boardHost);
    if (!lsGet('lb-hint-dismissed', false)) boardHost.append(this.hint);

    this.root.replaceChildren(h('div', { class: 'app' }, toolbar, main));

    this.board = new Board(boardHost, this.settings, {
      onStrokesAdded: (s) => this.record({ type: 'add', strokes: s }),
      onStrokesRemoved: (s) => this.record({ type: 'remove', strokes: s }),
      onContact: (size, type, accepted) => this.showContact(size, type, accepted),
      onUnlockChange: () => {},
    });

    this.buildSettings();
    this.renderToolOptions();
    this.renderUndo();
    this.bindKeys();
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.board.stepLine(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.board.stepLine(-1);
      } else if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        this.board.scrollBy((e.key === 'PageDown' ? 1 : -1) * PAGE_W * 0.6);
      } else if (!mod) {
        if (e.key === 'p') this.setTool('pen');
        if (e.key === 'h') this.setTool('highlighter');
        if (e.key === 'e') this.setTool('eraser');
        if (e.key === 'm') this.setMulti(!this.board.isMulti());
      }
    }, { signal: this.abort.signal });
  }

  private toggleSidebar(force?: boolean) {
    const open = force ?? !this.root.querySelector('.app')!.classList.contains('sidebar-open');
    this.root.querySelector('.app')!.classList.toggle('sidebar-open', open);
  }

  // ----------------------------- tools -----------------------------

  private setTool(t: Tool) {
    this.tool = t;
    this.board.setTool(t);
    this.renderToolOptions();
  }

  private setMulti(on: boolean) {
    this.board.setMulti(on);
    this.multiBtn.classList.toggle('on', on);
    this.multiBtn.setAttribute('aria-checked', String(on));
    if (!on) toast('All strips locked. Tap a lock in the margin to write.');
  }

  private renderToolOptions() {
    for (const [t, b] of this.toolBtns) b.classList.toggle('active', t === this.tool);
    const isHL = this.tool === 'highlighter';
    const colors = isHL ? HL_COLORS : PEN_COLORS;
    const cur = isHL ? this.settings.highlighterColor : this.settings.penColor;
    this.swatches.replaceChildren(
      ...colors.map((c) => {
        const b = h('button', { class: 'swatch' + (c === cur ? ' active' : ''), type: 'button', 'aria-label': 'Color ' + c, title: c });
        b.style.setProperty('--c', c);
        b.addEventListener('click', () => {
          if (isHL) this.settings.highlighterColor = c;
          else this.settings.penColor = c;
          if (this.tool === 'eraser') this.setTool('pen');
          this.settingsChanged();
          this.renderToolOptions();
        });
        return b;
      }),
    );
    const ws = isHL ? HL_WIDTHS : PEN_WIDTHS;
    const curW = isHL ? this.settings.highlighterWidth : this.settings.penWidth;
    this.widths.replaceChildren(
      ...ws.map((w, i) => {
        const b = h('button', { class: 'width-btn' + (w === curW ? ' active' : ''), type: 'button', 'aria-label': ['Thin', 'Medium', 'Thick'][i], title: ['Thin', 'Medium', 'Thick'][i] });
        const dot = h('i');
        const px = 4 + i * 4;
        dot.style.width = dot.style.height = px + 'px';
        b.append(dot);
        b.addEventListener('click', () => {
          if (isHL) this.settings.highlighterWidth = w;
          else this.settings.penWidth = w;
          this.settingsChanged();
          this.renderToolOptions();
        });
        return b;
      }),
    );
    const hide = this.tool === 'eraser';
    this.swatches.style.display = hide ? 'none' : '';
    this.widths.style.display = hide ? 'none' : '';
  }

  private settingsChanged() {
    lsSet(this.lsKey('settings'), this.settings);
    this.board.updateSettings(this.settings);
    this.saveSettingsDebounced();
  }

  // ----------------------------- undo / sync -----------------------------

  private record(a: Action) {
    this.undoStack.push(a);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.apply(a, false);
    this.renderUndo();
  }

  /** Persist an action. `toBoard` also updates the canvas (for undo/redo; live input already did). */
  private apply(a: Action, toBoard: boolean) {
    if (a.type === 'add') {
      if (toBoard) this.board.addStrokes(a.strokes);
      this.queue.upsert(a.strokes);
    } else {
      if (toBoard) this.board.removeStrokes(a.strokes.map((s) => s.id));
      this.queue.remove(a.strokes.map((s) => s.id));
    }
    this.bumpCurrent();
  }

  private invert(a: Action): Action {
    return { type: a.type === 'add' ? 'remove' : 'add', strokes: a.strokes };
  }

  private undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    this.apply(this.invert(a), true);
    this.redoStack.push(a);
    this.renderUndo();
  }

  private redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    this.apply(a, true);
    this.undoStack.push(a);
    this.renderUndo();
  }

  private renderUndo() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  private renderStatus(s: SyncState) {
    const local = this.store.mode === 'local';
    const text = { saved: local ? 'Saved on device' : 'Saved', saving: 'Saving...', retrying: 'Offline, will retry' }[s];
    this.status.className = 'status ' + s;
    this.status.textContent = text;
  }

  private bumpCurrent() {
    if (!this.current) return;
    this.current.updated_at = new Date().toISOString();
  }

  // ----------------------------- notes -----------------------------

  private async refreshNotes() {
    try {
      this.notes = await this.store.listNotes();
    } catch (e) {
      toast('Could not load notes: ' + (e as Error).message, 'error');
    }
    this.renderNoteList();
  }

  private renderNoteList() {
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    this.noteList.replaceChildren(
      ...this.notes.map((n) => {
        const active = n.id === this.current?.id;
        const open = h('button', { class: 'note-open', type: 'button' }, h('span', { class: 'note-title' }, n.title || 'Untitled'), h('span', { class: 'note-date' }, fmt.format(new Date(n.updated_at))));
        open.addEventListener('click', () => {
          void this.openNote(n);
          if (window.innerWidth < 900) this.toggleSidebar(false);
        });
        const del = this.iconBtn(icons.trash, 'Delete note', () => void this.deleteNote(n), 'small');
        const ren = this.iconBtn(icons.edit, 'Rename note', () => void this.promptRename(n), 'small');
        return h('li', { class: active ? 'active' : '' }, open, h('div', { class: 'note-actions' }, ren, del));
      }),
    );
  }

  private async openNote(n: NoteMeta) {
    const token = ++this.loadToken;
    this.current = n;
    this.titleInput.value = n.title;
    lsSet(this.lsKey('last-note'), n.id);
    this.undoStack = [];
    this.redoStack = [];
    this.renderUndo();
    this.renderNoteList();
    this.board.setStrokes(n.id, []);
    try {
      const loaded = await this.store.loadStrokes(n.id);
      if (token !== this.loadToken) return;
      this.board.setStrokes(n.id, this.queue.overlay(n.id, loaded));
    } catch (e) {
      if (token !== this.loadToken) return;
      // Offline: show whatever is still waiting to be saved for this note.
      this.board.setStrokes(n.id, this.queue.overlay(n.id, []));
      toast('Could not load this note: ' + (e as Error).message, 'error');
    }
  }

  private async newNote() {
    const d = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
    try {
      const n = await this.store.createNote(`Note ${d}`);
      this.notes.unshift(n);
      await this.openNote(n);
    } catch (e) {
      toast('Could not create note: ' + (e as Error).message, 'error');
    }
  }

  private async renameCurrent(title: string) {
    if (!this.current) return;
    const t = title.trim() || 'Untitled';
    await this.rename(this.current, t);
  }

  private async promptRename(n: NoteMeta) {
    const t = await dialog({ title: 'Rename note', input: n.title, ok: 'Rename' });
    if (t === null) return;
    await this.rename(n, t.trim() || 'Untitled');
  }

  private async rename(n: NoteMeta, title: string) {
    const old = n.title;
    n.title = title;
    if (n.id === this.current?.id) this.titleInput.value = title;
    this.renderNoteList();
    try {
      await this.store.renameNote(n.id, title);
    } catch (e) {
      n.title = old;
      if (n.id === this.current?.id) this.titleInput.value = old;
      this.renderNoteList();
      toast('Rename failed: ' + (e as Error).message, 'error');
    }
  }

  private async deleteNote(n: NoteMeta) {
    const ok = await dialog({ title: 'Delete note?', message: `"${n.title}" will be deleted permanently.`, ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      this.queue.dropNote(n.id);
      await this.store.deleteNote(n.id);
      this.notes = this.notes.filter((x) => x.id !== n.id);
      if (this.current?.id === n.id) {
        this.current = null;
        if (this.notes[0]) await this.openNote(this.notes[0]);
        else await this.newNote();
      }
      this.renderNoteList();
    } catch (e) {
      toast('Delete failed: ' + (e as Error).message, 'error');
    }
  }

  private async exportPNG() {
    try {
      const blob = await this.board.exportPNG();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${(this.current?.title || 'note').replace(/[^\w\- ]+/g, '_')}.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast('Export failed: ' + (e as Error).message, 'error');
    }
  }

  // ----------------------------- settings -----------------------------

  private showContact(size: number, type: string, accepted: boolean) {
    if (!this.contactReadout) return;
    const reason = accepted ? 'drawn' : 'ignored';
    this.contactReadout.textContent = `Last contact on page: ${size ? Math.round(size) + ' px' : 'size not reported'} (${type}, ${reason})`;
  }

  private buildSettings() {
    const s = () => this.settings;
    const row = (label: string, control: HTMLElement, help?: string) =>
      h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label), control, help ? h('small', {}, help) : null);

    // Strip height
    const stripVal = h('output');
    const strip = h('input', { type: 'range', min: '40', max: '220', step: '5' }) as HTMLInputElement;
    const updStrip = () => {
      const px = Math.round((Number(strip.value) * (document.querySelector('.canvas-area')?.clientWidth ?? PAGE_W)) / PAGE_W);
      stripVal.textContent = `${strip.value} (~ ${px} px on this screen)`;
    };
    strip.addEventListener('input', () => {
      s().stripHeight = Number(strip.value);
      updStrip();
      this.settingsChanged();
    });

    // Touch threshold
    const thrVal = h('output');
    const thr = h('input', { type: 'range', min: '5', max: '150', step: '1' }) as HTMLInputElement;
    thr.addEventListener('input', () => {
      s().touchThreshold = Number(thr.value);
      thrVal.textContent = thr.value + ' px';
      this.settingsChanged();
    });

    // Calibration pad
    let samples: number[] = [];
    const calOut = h('span', { class: 'cal-out' }, 'No samples yet.');
    const pad = h('div', { class: 'cal-pad' }, 'Write here with your stylus');
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
    });
    const sample = (e: PointerEvent) => {
      if (e.buttons === 0 && e.type === 'pointermove') return;
      const v = Math.max(e.width || 0, e.height || 0);
      samples.push(v);
      const max = Math.max(...samples);
      calOut.textContent = `Stylus contact: up to ${Math.round(max)} px over ${samples.length} samples.`;
    };
    pad.addEventListener('pointerdown', sample);
    pad.addEventListener('pointermove', sample);
    const useCal = h('button', { class: 'btn', type: 'button' }, 'Set limit from samples');
    useCal.addEventListener('click', () => {
      if (!samples.length) return toast('Write in the box with your stylus first.');
      const max = Math.max(...samples);
      if (max <= 1) return toast('This browser does not report contact size, so size filtering cannot help here. Strips still work.');
      const v = Math.min(150, Math.max(5, Math.ceil(max * 1.4 + 4)));
      s().touchThreshold = v;
      thr.value = String(v);
      thrVal.textContent = v + ' px';
      this.settingsChanged();
      toast(`Palm limit set to ${v} px.`);
    });
    const resetCal = h('button', { class: 'btn', type: 'button' }, 'Clear');
    resetCal.addEventListener('click', () => {
      samples = [];
      calOut.textContent = 'No samples yet.';
    });

    const penOnly = h('input', { type: 'checkbox' }) as HTMLInputElement;
    penOnly.addEventListener('change', () => {
      s().penOnlyWhenPenSeen = penOnly.checked;
      this.settingsChanged();
    });
    const lines = h('input', { type: 'checkbox' }) as HTMLInputElement;
    lines.addEventListener('change', () => {
      s().showLines = lines.checked;
      this.settingsChanged();
    });
    const side = h('select', {}, h('option', { value: 'left' }, 'Left (right-handed)'), h('option', { value: 'right' }, 'Right (left-handed)')) as HTMLSelectElement;
    side.addEventListener('change', () => {
      s().marginSide = side.value as 'left' | 'right';
      this.settingsChanged();
    });

    this.contactReadout = h('p', { class: 'readout' }, 'Last contact on page: none yet');

    const account = h('div', { class: 'set-account' });
    if (this.signOut) {
      const out = h('button', { class: 'btn', type: 'button' }, 'Sign out');
      out.addEventListener('click', async () => {
        if (this.queue.pending) {
          const ok = await dialog({ title: 'Unsaved changes', message: 'Some strokes are still being saved. Sign out anyway?', ok: 'Sign out', danger: true });
          if (!ok) return;
        }
        await this.signOut!();
      });
      account.append(h('span', {}, 'Signed in as ', h('b', {}, this.user.email ?? '')), out);
    } else {
      account.append(h('span', {}, 'Local mode. Configure Supabase to sync across devices.'));
    }

    const close = h('button', { class: 'btn primary', type: 'button' }, 'Done');
    this.settingsDlg = h(
      'dialog',
      { class: 'modal' },
      h(
        'div',
        { class: 'settings' },
        h('h2', {}, 'Settings'),
        h('h4', {}, 'Strips'),
        row('Strip height', h('div', { class: 'range' }, strip, stripVal), 'Taller strips leave more room for big handwriting.'),
        row('Lock icons on the', side),
        h('label', { class: 'set-check' }, lines, h('span', {}, 'Show ruled lines between strips')),
        h('h4', {}, 'Palm rejection inside the unlocked strip'),
        row('Ignore touches larger than', h('div', { class: 'range' }, thr, thrVal), 'Palms register as big contacts. Calibrate below for your stylus.'),
        h('div', { class: 'cal' }, pad, h('div', { class: 'cal-side' }, calOut, h('div', { class: 'cal-btns' }, useCal, resetCal))),
        this.contactReadout,
        h('label', { class: 'set-check' }, penOnly, h('span', {}, 'If an active pen is detected, ignore finger touches completely')),
        h('h4', {}, 'Account'),
        account,
        h('div', { class: 'dlg-actions' }, close),
      ),
    );
    close.addEventListener('click', () => this.settingsDlg.close());
    this.settingsDlg.addEventListener('click', (e) => {
      if (e.target === this.settingsDlg) this.settingsDlg.close();
    });
    document.body.append(this.settingsDlg);

    this.syncSettingsForm = () => {
      strip.value = String(s().stripHeight);
      updStrip();
      thr.value = String(s().touchThreshold);
      thrVal.textContent = s().touchThreshold + ' px';
      penOnly.checked = s().penOnlyWhenPenSeen;
      lines.checked = s().showLines;
      side.value = s().marginSide;
    };
  }

  private syncSettingsForm: () => void = () => {};

  private openSettings() {
    this.syncSettingsForm();
    this.settingsDlg.showModal();
  }
}
