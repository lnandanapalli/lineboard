import { Board, PAGE_W } from './board';
import { SettingsPanel } from './settings';
import type { AccountSecurity } from './account';
import { icons } from './icons';
import { logo } from './brand';
import type { Store } from './store/store';
import { SyncQueue, type SyncState } from './sync';
import { DEFAULT_SETTINGS, type AppUser, type Notebook, type NoteMeta, type Settings, type Stroke, type Tool } from './types';
import { debounce, dialog, h, lsGet, lsSet, toast } from './util';

const PEN_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'];
const PEN_WIDTHS = [2, 3.5, 6];
const HL_WIDTHS = [14, 22, 32];

type Action = { type: 'add' | 'remove'; strokes: Stroke[] };

export interface AppOptions {
  /** Signed in: sign out of the account. */
  signOut?: () => Promise<void>;
  /** Trying without an account: go to sign-in; notes on this device are moved into the account afterwards. */
  signIn?: () => void;
  /** Account security (password, two-step verification, passkeys, devices). */
  account?: AccountSecurity;
}

export class App {
  private settings: Settings;
  private board!: Board;
  private queue: SyncQueue;
  private notes: NoteMeta[] = [];
  private notebooks: Notebook[] = [];
  private currentBook: Notebook | null = null;
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
  private bookButton!: HTMLButtonElement;
  private bookPanel!: HTMLElement;
  private titleInput!: HTMLInputElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private swatches!: HTMLElement;
  private widths!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private multiBtn!: HTMLButtonElement;
  private freeBtn!: HTMLButtonElement;
  private stripControls!: HTMLElement;
  private status!: HTMLElement;
  private settingsPanel!: SettingsPanel;
  private hint!: HTMLElement;

  private saveSettingsDebounced = debounce(() => {
    this.store.saveSettings(this.settings).catch((e) => console.warn('Settings not saved', e));
  }, 800);

  constructor(
    root: HTMLElement,
    private store: Store,
    private user: AppUser,
    private opts: AppOptions = {},
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

  /** Wait (briefly) until queued saves are written, e.g. before leaving guest mode. */
  async flush(timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    while (this.queue.pending && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  }

  private async goSignIn() {
    await this.flush();
    this.opts.signIn?.();
  }

  /** Tear down before switching user. */
  destroy() {
    this.abort.abort();
    this.queue.stop();
    this.settingsPanel.destroy();
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
        this.renderFree();
      }
    } catch (e) {
      console.warn('Could not load settings', e);
    }
    await this.loadLibrary();
    const lastNote = this.notes.find((n) => n.id === lsGet<string | null>(this.lsKey('last-note'), null));
    const lastBookId = lastNote?.notebook_id ?? lsGet<string | null>(this.lsKey('last-notebook'), null);
    const book = this.notebooks.find((b) => b.id === lastBookId) ?? this.notebooks[0];
    if (book) await this.switchNotebook(book, lastNote);
  }

  /** Load notebooks and notes; create the default notebook and file older, notebook-less notes into it. */
  private async loadLibrary() {
    try {
      let books = await this.store.listNotebooks();
      if (!books.length) books = [await this.store.ensureDefaultNotebook()];
      this.notebooks = books;
      this.notes = await this.store.listNotes();
      const known = new Set(books.map((b) => b.id));
      const orphans = this.notes.filter((n) => !n.notebook_id || !known.has(n.notebook_id));
      if (orphans.length) {
        const home = books.find((b) => b.id === this.user.id) ?? books[0];
        await this.store.moveNotes(
          orphans.map((n) => n.id),
          home.id,
        );
        for (const n of orphans) n.notebook_id = home.id;
      }
    } catch (e) {
      toast('Could not load your notebooks: ' + (e as Error).message, 'error');
    }
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

    this.multiBtn = h('button', {
      class: 'toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': 'Multi-strip',
      title: 'Multi-strip: unlock several strips at once (M)',
    }) as HTMLButtonElement;
    this.multiBtn.innerHTML = `${icons.multi}<span>Multi-strip</span><i class="knob"></i>`;
    this.multiBtn.addEventListener('click', () => this.setMulti(!this.board.isMulti()));

    this.freeBtn = h('button', {
      class: 'toggle free-toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      'aria-label': 'Free whiteboard',
      title: 'Free whiteboard: no strips or locks (F). Two fingers scroll and zoom.',
    }) as HTMLButtonElement;
    this.freeBtn.innerHTML = `${icons.free}<span>Free</span><i class="knob"></i>`;
    this.freeBtn.addEventListener('click', () => this.setFree(!this.settings.freeMode));

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
      this.freeBtn,
      (this.stripControls = h(
        'div',
        { class: 'group strip-controls' },
        this.multiBtn,
        this.iconBtn(icons.up, 'Previous strip (Up arrow)', () => this.board.stepLine(-1)),
        this.iconBtn(icons.down, 'Next strip (Down arrow)', () => this.board.stepLine(1)),
        this.iconBtn(icons.lockAll, 'Lock all strips', () => this.board.lockAll()),
      )),
      h('div', { class: 'spacer' }),
      this.opts.signIn ? this.signInButton('toolbar') : null,
      this.status,
      this.iconBtn(icons.download, 'Export as PNG', () => void this.exportPNG()),
      this.iconBtn(icons.gear, 'Settings', () => this.openSettings()),
    );

    // Sidebar
    this.bookButton = h('button', { class: 'book-button', type: 'button', 'aria-expanded': 'false', title: 'Switch notebook' }) as HTMLButtonElement;
    this.bookButton.addEventListener('click', () => this.toggleBookPanel());
    this.bookPanel = h('div', { class: 'book-panel', hidden: true });
    this.noteList = h('ul', { class: 'note-list' });
    const newBtn = h('button', { class: 'btn primary', type: 'button' });
    newBtn.innerHTML = `${icons.plus}<span>New note</span>`;
    newBtn.addEventListener('click', () => void this.newNote());
    this.sidebar = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'sidebar-head' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')), this.iconBtn(icons.close, 'Close', () => this.toggleSidebar(false))),
      h('div', { class: 'section-label' }, 'Notebook'),
      this.bookButton,
      this.bookPanel,
      newBtn,
      this.noteList,
      h(
        'div',
        { class: 'sidebar-foot' },
        this.opts.signIn
          ? 'Trying without an account: notes are saved in this browser only.'
          : this.store.mode === 'local'
            ? 'Local mode: notes stay on this device.'
            : (this.user.email ?? ''),
      ),
      this.opts.signIn ? this.signInButton('sidebar') : null,
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
      onContact: (size, type, accepted) => this.settingsPanel?.showContact(size, type, accepted),
      onUnlockChange: () => {},
    });

    this.buildSettings();
    this.renderToolOptions();
    this.renderFree();
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
        if (e.key === 'm' && !this.settings.freeMode) this.setMulti(!this.board.isMulti());
        if (e.key === 'f') this.setFree(!this.settings.freeMode);
      }
    }, { signal: this.abort.signal });
  }

  private signInButton(where: 'toolbar' | 'sidebar' | 'settings') {
    const b = h('button', { class: 'btn primary signin-save signin-' + where, type: 'button', title: 'Sign in or create an account to save your notes' }) as HTMLButtonElement;
    b.innerHTML = `${icons.cloud}<span>Sign in to save</span>`;
    b.addEventListener('click', () => {
      if (where === 'settings') this.settingsPanel.close();
      void this.goSignIn();
    });
    return b;
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

  /** Free whiteboard on/off. Strokes are unaffected; only how input is taken changes. */
  private setFree(on: boolean) {
    this.settings.freeMode = on;
    this.settingsChanged();
    this.renderFree();
    toast(on ? 'Free whiteboard: write anywhere. Two fingers scroll and pinch to zoom.' : 'Strips are back: tap a lock in the margin to write.');
  }

  private renderFree() {
    const on = this.settings.freeMode;
    this.freeBtn.classList.toggle('on', on);
    this.freeBtn.setAttribute('aria-checked', String(on));
    this.stripControls.hidden = on;
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
    // In guest mode the "Sign in to save" button sits next to it, so show just the coloured dot.
    this.status.className = 'status ' + s + (this.opts.signIn ? ' compact' : '');
    this.status.textContent = text;
    this.status.title = text;
    this.status.setAttribute('aria-label', text);
  }

  private bumpCurrent() {
    if (!this.current) return;
    this.current.updated_at = new Date().toISOString();
  }

  // ----------------------------- notes -----------------------------

  /** Notes in the current notebook, most recently changed first. */
  private visibleNotes(): NoteMeta[] {
    const id = this.currentBook?.id;
    return this.notes.filter((n) => n.notebook_id === id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  private renderNoteList() {
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    this.noteList.replaceChildren(
      ...this.visibleNotes().map((n) => {
        const active = n.id === this.current?.id;
        const open = h('button', { class: 'note-open', type: 'button' }, h('span', { class: 'note-title' }, n.title || 'Untitled'), h('span', { class: 'note-date' }, fmt.format(new Date(n.updated_at))));
        open.addEventListener('click', () => {
          void this.openNote(n);
          if (window.innerWidth < 900) this.toggleSidebar(false);
        });
        const del = this.iconBtn(icons.trash, 'Delete note', () => void this.deleteNote(n), 'small');
        const ren = this.iconBtn(icons.edit, 'Rename note', () => void this.promptRename(n), 'small');
        const mv = this.iconBtn(icons.move, 'Move to another notebook', () => void this.moveNote(n), 'small');
        return h('li', { class: active ? 'active' : '' }, open, h('div', { class: 'note-actions' }, ren, mv, del));
      }),
    );
    this.renderNotebooks(); // keep the per-notebook note counts current
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
      if (!this.currentBook) return;
      const n = await this.store.createNote(`Note ${d}`, this.currentBook.id);
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
        const next = this.visibleNotes()[0];
        if (next) await this.openNote(next);
        else await this.newNote();
      }
      this.renderNoteList();
    } catch (e) {
      toast('Delete failed: ' + (e as Error).message, 'error');
    }
  }

  // ----------------------------- notebooks -----------------------------

  private renderNotebooks() {
    const b = this.currentBook;
    this.bookButton.innerHTML = `${icons.notebook}<span class="book-name"></span>${icons.chevron}`;
    this.bookButton.querySelector('.book-name')!.textContent = b?.name ?? '';
    const counts = new Map<string, number>();
    for (const n of this.notes) if (n.notebook_id) counts.set(n.notebook_id, (counts.get(n.notebook_id) ?? 0) + 1);
    const items = this.notebooks.map((nb) => {
      const open = h(
        'button',
        { class: 'book-open', type: 'button' },
        h('span', { class: 'book-title' }, nb.name),
        h('span', { class: 'book-count' }, String(counts.get(nb.id) ?? 0)),
      );
      open.addEventListener('click', () => {
        this.toggleBookPanel(false);
        if (nb.id !== this.currentBook?.id) void this.switchNotebook(nb);
      });
      const ren = this.iconBtn(icons.edit, 'Rename notebook', () => void this.renameNotebook(nb), 'small');
      const del = this.iconBtn(icons.trash, 'Delete notebook', () => void this.deleteNotebook(nb), 'small');
      return h('li', { class: nb.id === b?.id ? 'active' : '' }, open, h('div', { class: 'note-actions' }, ren, del));
    });
    const add = h('button', { class: 'btn book-new', type: 'button' });
    add.innerHTML = `${icons.plus}<span>New notebook</span>`;
    add.addEventListener('click', () => void this.newNotebook());
    this.bookPanel.replaceChildren(h('ul', { class: 'book-list' }, ...items), add);
  }

  private toggleBookPanel(force?: boolean) {
    const open = force ?? this.bookPanel.hidden === true;
    this.bookPanel.hidden = !open;
    this.bookButton.setAttribute('aria-expanded', String(open));
    this.bookButton.classList.toggle('open', open);
  }

  /** Show a notebook and open one of its notes (a fresh note if it has none). */
  private async switchNotebook(book: Notebook, note?: NoteMeta) {
    this.currentBook = book;
    lsSet(this.lsKey('last-notebook'), book.id);
    this.renderNotebooks();
    const target = note && note.notebook_id === book.id ? note : this.visibleNotes()[0];
    if (target) await this.openNote(target);
    else await this.newNote();
  }

  private async newNotebook() {
    const name = await dialog({ title: 'New notebook', input: `Notebook ${this.notebooks.length + 1}`, ok: 'Create' });
    if (name === null) return;
    try {
      const b = await this.store.createNotebook(name.trim() || 'Untitled notebook');
      this.notebooks.push(b);
      this.toggleBookPanel(false);
      await this.switchNotebook(b);
    } catch (e) {
      toast('Could not create notebook: ' + (e as Error).message, 'error');
    }
  }

  private async renameNotebook(b: Notebook) {
    const name = await dialog({ title: 'Rename notebook', input: b.name, ok: 'Rename' });
    if (name === null) return;
    const old = b.name;
    b.name = name.trim() || 'Untitled notebook';
    this.renderNotebooks();
    try {
      await this.store.renameNotebook(b.id, b.name);
    } catch (e) {
      b.name = old;
      this.renderNotebooks();
      toast('Rename failed: ' + (e as Error).message, 'error');
    }
  }

  private async deleteNotebook(b: Notebook) {
    const inside = this.notes.filter((n) => n.notebook_id === b.id);
    const what = inside.length === 1 ? 'its 1 note' : `its ${inside.length} notes`;
    const ok = await dialog({
      title: 'Delete notebook?',
      message: `"${b.name}" and ${what} will be deleted permanently.`,
      ok: 'Delete notebook',
      danger: true,
    });
    if (!ok) return;
    try {
      for (const n of inside) this.queue.dropNote(n.id);
      await this.store.deleteNotebook(b.id);
      const gone = new Set(inside.map((n) => n.id));
      this.notes = this.notes.filter((n) => !gone.has(n.id));
      this.notebooks = this.notebooks.filter((x) => x.id !== b.id);
      if (!this.notebooks.length) this.notebooks = [await this.store.ensureDefaultNotebook()];
      if (this.currentBook?.id === b.id) {
        this.current = null;
        await this.switchNotebook(this.notebooks[0]);
      } else this.renderNotebooks();
    } catch (e) {
      toast('Delete failed: ' + (e as Error).message, 'error');
    }
  }

  private async moveNote(n: NoteMeta) {
    const others = this.notebooks.filter((b) => b.id !== n.notebook_id);
    if (!others.length) return toast('Create another notebook first, then move notes into it.');
    const target = await dialog({
      title: 'Move note',
      message: `Move "${n.title}" to:`,
      choices: others.map((b) => ({ value: b.id, label: b.name })),
      ok: 'Move',
    });
    if (target === null) return;
    const book = this.notebooks.find((b) => b.id === target);
    if (!book) return;
    const from = n.notebook_id;
    n.notebook_id = book.id;
    try {
      await this.store.moveNotes([n.id], book.id);
      // Follow the note if it is the one open; otherwise it just leaves this list.
      if (n.id === this.current?.id) await this.switchNotebook(book, n);
      else {
        this.renderNotebooks();
        this.renderNoteList();
      }
      toast(`Moved to "${book.name}".`);
    } catch (e) {
      n.notebook_id = from;
      toast('Move failed: ' + (e as Error).message, 'error');
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

  private buildSettings() {
    this.settingsPanel = new SettingsPanel({
      user: this.user,
      store: this.store,
      settings: () => this.settings,
      changed: () => this.settingsChanged(),
      setFree: (on) => this.setFree(on),
      pendingSaves: () => this.queue.pending,
      noteCount: () => this.notes.length,
      signOut: this.opts.signOut,
      account: this.opts.account,
      signInButton: this.opts.signIn ? () => this.signInButton('settings') : undefined,
    });
  }

  private openSettings() {
    this.settingsPanel.open();
  }
}
