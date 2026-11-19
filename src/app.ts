import { HL_COLORS, PEN_COLORS } from './colors';
import { Board, PAGE_W, TEXT_FONT } from './board';
import { SettingsPanel } from './settings';
import type { AccountSecurity } from './account';
import { icons } from './icons';
import { logo } from './brand';
import type { Store } from './store/store';
import { SyncQueue, type SyncState } from './sync';
import { LINE_STYLE_NAMES, LINE_STYLES, LINE_WIDTHS, SHAPE_ICONS, SHAPE_NAMES, SHAPES } from './shapes';
import { IMAGE_TYPES, prepareImage } from './images';
import { withDefaults, type AppUser, type BoardMode, type Flags, type Notebook, type NoteMeta, type Settings, type Stroke, type Tool } from './types';
import { actionMenu, closeOpenMenu, dropdown, popover, type Dropdown } from './menu';
import { isApple, withShortcut } from './keys';
import { appRect, appViewport, attachOrientation, clientToApp, detachOrientation, orientation } from './orientation';
import { attachNameTips } from './nameTip';
import { debounce, dialog, h, lsGet, lsSet, toast, uuid } from './util';
import { buildExport } from './dataExport';
import { buildLbd, fileName, importDocument, LBD_EXT, readNotesFile } from './lbd';
import { confirmItsYou } from './securityUi';
import { canvasToPdf } from './pdf';
import { openSearch } from './searchUi';
import { avatar, EMPTY_PROFILE, squarePicture, type Profile } from './profile';
import { clip, MAX_IMPORT_FILE, MAX_NOTE_TITLE, MAX_NOTEBOOK_NAME, MAX_PICTURES_AT_ONCE } from './limits';
import { LocalStore } from './store/localStore';
import { HISTORY_NEEDS_UPDATE, HistoryPanel, VersionRecorder } from './historyUi';



/** Size ranges (page units; the page is 1000 wide) and quick presets for each tool. */
const SIZES = {
  pen: { min: 1, max: 24, step: 0.5, presets: [2, 3.5, 6] },
  highlighter: { min: 6, max: 60, step: 1, presets: [14, 22, 32] },
  text: { min: 10, max: 100, step: 1, presets: [20, 28, 44] },
  // Same range the settings accept; the presets match the palette's thickness choices.
  shape: { min: 1, max: 20, step: 0.5, presets: [2, 3.5, 6, 10] },
};

type Action = { type: 'add' | 'remove'; strokes: Stroke[] } | { type: 'replace'; from: Stroke[]; to: Stroke[] };

export interface AppOptions {
  /** Signed in: sign out of the account. */
  signOut?: () => Promise<void>;
  /** Trying without an account: go to sign-in; notes on this device are moved into the account afterwards. */
  signIn?: () => void;
  /** Account security (password, two-step verification, passkeys, devices). */
  account?: AccountSecurity;
  /** The account was deleted: leave the app (sign out locally, forget this device's copies). */
  onAccountDeleted?: () => Promise<void>;
}

/** Said when an export could not include every picture. */
/** Is a colour light (dark marks show better on it)? Relative luminance, as in WCAG. */
function isLight(color: string) {
  // The whole value: #rgb or #rrggbb, with an optional alpha (#rgba, #rrggbbaa) that is ignored.
  const m = /^#(?:([0-9a-f]{6})(?:[0-9a-f]{2})?|([0-9a-f]{3})[0-9a-f]?)$/i.exec(color);
  if (!m) return true;
  const hex = m[1] ?? [...m[2]].map((x) => x + x).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

const missingNote = (n: number) =>
  `Downloaded, but ${n === 1 ? '1 picture' : `${n} pictures`} could not be read and ${n === 1 ? 'is' : 'are'} not in the file. Check your connection and export again.`;

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
  private sizeBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private modeMenu!: Dropdown<BoardMode>;
  private shapeBtn!: HTMLButtonElement;
  private shapeMain!: HTMLButtonElement;
  private shapeTool!: HTMLElement;
  private selectMenu!: Dropdown<'lasso' | 'rect'>;
  /** The last strip mode, so F (free on/off) returns to it. */
  private lastStripMode: BoardMode = 'strips';
  private stripControls!: HTMLElement;
  private status!: HTMLElement;
  private rotateBtn!: HTMLButtonElement;
  private appEl!: HTMLElement;
  private settingsPanel!: SettingsPanel;
  private hint!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  /** Saves versions of notes as they change (version history). */
  private history: VersionRecorder;
  private historyPanel: HistoryPanel | null = null;

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
    this.settings = withDefaults(lsGet<Partial<Settings>>(this.lsKey('settings'), {}));
    this.queue = new SyncQueue(store, this.lsKey('queue'));
    this.history = new VersionRecorder(store, this.lsKey('history'), async (id) => {
      // The open note: what is on the board (null while it is still loading).
      if (id === this.current?.id) return this.loadedNote === id ? this.board.allStrokes() : null;
      return this.queue.overlay(id, await this.store.loadStrokes(id));
    });
    this.queue.onDropped = (m) => toast('Not saved: ' + m, 'error');
    this.queue.onStorageFull = () => toast('This browser’s storage is full, so changes waiting to be saved are kept only until you close the page. Reconnect, or free some space, to keep them.', 'error');
    this.queue.onState = (s) => {
      this.syncState = s;
      this.renderStatus();
    };
    this.build();
    this.syncState = this.queue.pending ? 'saving' : 'saved';
    this.renderStatus();
    window.addEventListener(
      'beforeunload',
      (e) => {
        this.board.finishText();
        if (this.queue.pending) {
          e.preventDefault();
          e.returnValue = '';
        }
      },
      { signal: this.abort.signal },
    );
    // Settings are saved to the store shortly after the last change; don't lose that when the tab closes.
    // Before the tab goes away: save settings now, and finish a text box still being typed (its text
    // goes into the persistent save queue, so it is not lost on reload).
    window.addEventListener(
      'pagehide',
      () => {
        this.board.finishText();
        this.saveSettingsDebounced.flush();
        if (this.current && this.loadedNote === this.current.id) this.history.leave(this.current.id, this.board.allStrokes());
      },
      { signal: this.abort.signal },
    );
    this.ready = this.init();
  }

  /** Settles once the notebooks are loaded and a note is open. */
  private ready: Promise<void> = Promise.resolve();

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
    this.historyPanel?.close();
    this.history.stop();
    this.queue.stop();
    detachOrientation(this.appEl);
    this.settingsPanel.destroy();
  }

  private lsKey(k: string) {
    return `lb-${k}-${this.user.id}`;
  }

  private async init() {
    void this.loadProfile();
    try {
      const remote = await this.store.loadSettings();
      if (remote) {
        this.settings = withDefaults(remote);
        lsSet(this.lsKey('settings'), this.settings);
        this.board.updateSettings(this.settings);
        this.renderToolOptions();
        this.renderMode();
      }
    } catch (e) {
      console.warn('Could not load settings', e);
    }
    await this.loadLibrary();
    const lastNote = this.notes.find((n) => n.id === lsGet<string | null>(this.lsKey('last-note'), null));
    const lastBookId = lastNote?.notebook_id ?? lsGet<string | null>(this.lsKey('last-notebook'), null);
    const active = this.activeBooks();
    const book = active.find((b) => b.id === lastBookId) ?? active[0];
    if (book) await this.switchNotebook(book, lastNote && !lastNote.archived_at ? lastNote : undefined);
    // Versions left to save from an earlier visit (a closed tab, a reload).
    void this.history.catchUp(this.current?.id ?? null, (id) => this.notes.some((n) => n.id === id));
  }

  /** Load notebooks and notes; create the default notebook and file older, notebook-less notes into it. */
  private async loadLibrary() {
    try {
      let books = await this.store.listNotebooks();
      if (!books.length) books = [await this.store.ensureDefaultNotebook()];
      this.notebooks = books;
      this.notes = await this.store.listNotes();
      // Every notebook archived (on another device): bring one back, there must be somewhere to write.
      if (!books.some((b) => !b.archived_at)) {
        await this.store.setNotebookFlags(books[0].id, { archived_at: null }).catch(() => {});
        books[0].archived_at = null;
      }
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
    this.titleInput = h('input', { class: 'title-input', type: 'text', 'aria-label': 'Note title', maxlength: String(MAX_NOTE_TITLE) }) as HTMLInputElement;
    this.titleInput.addEventListener('change', () => void this.renameCurrent(this.titleInput.value));
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.titleInput.blur();
    });

    const tools = h('div', { class: 'group' });
    for (const [t, icon, label, key] of [
      ['pen', icons.pen, 'Pen', 'P'],
      ['highlighter', icons.highlighter, 'Highlighter', 'H'],
      ['eraser', icons.eraser, 'Eraser', 'E'],
      ['text', icons.text, 'Text', 'T'],
    ] as const) {
      const b = this.iconBtn(icon, label, () => this.setTool(t), 'tool');
      b.title = withShortcut(label, key);
      this.toolBtns.set(t, b);
      tools.append(b);
    }
    // Select: a free-hand loop or a dragged rectangle.
    this.selectMenu = dropdown<'lasso' | 'rect'>({
      name: 'Select',
      className: 'select-btn',
      value: this.settings.selectMode,
      reselect: true,
      // The icon picks the Select tool as last used; the arrow chooses lasso or rectangle.
      split: { className: 'select-tool', onMain: () => this.setTool('select'), title: (t) => withShortcut(t, 'V') },
      onSelect: (m) => {
        this.settings.selectMode = m;
        this.settingsChanged();
        this.setTool('select');
      },
      options: [
        { value: 'lasso', label: 'Lasso select', icon: icons.lasso, hint: 'V', description: 'Draw a loop around what you want.' },
        { value: 'rect', label: 'Rectangle select', icon: icons.rectSelect, hint: 'V', description: 'Drag a box around what you want.' },
      ],
    });
    tools.append(this.selectMenu.el);
    // Shapes: the icon draws the last shape picked; the arrow opens the palette.
    this.shapeMain = h('button', { class: 'split-main', type: 'button' }) as HTMLButtonElement;
    this.shapeMain.addEventListener('click', () => this.setTool('shape'));
    this.shapeBtn = h('button', { class: 'split-arrow shape-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Shape options', title: 'Shape options' }) as HTMLButtonElement;
    this.shapeBtn.innerHTML = icons.chevron;
    this.shapeBtn.addEventListener('click', () => this.openShapePalette());
    this.shapeTool = h('div', { class: 'split-btn shape-tool', role: 'group', 'aria-label': 'Shapes' }, this.shapeMain, this.shapeBtn);
    tools.append(this.shapeTool);
    // Insert a picture (also: paste, or drop a file on the page).
    const filePick = h('input', { type: 'file', accept: IMAGE_TYPES, multiple: true, hidden: true, 'aria-hidden': 'true' }) as HTMLInputElement;
    filePick.addEventListener('change', () => {
      void this.insertImages([...(filePick.files ?? [])]);
      filePick.value = '';
    });
    const imageBtn = this.iconBtn(icons.image, 'Insert picture', () => filePick.click());
    tools.append(imageBtn, filePick);
    this.swatches = h('div', { class: 'group swatches' });
    this.sizeBtn = h('button', { class: 'size-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    this.sizeBtn.addEventListener('click', () => this.openSizePicker());

    this.undoBtn = this.iconBtn(icons.undo, withShortcut('Undo', 'Mod+Z'), () => this.undo());
    this.redoBtn = this.iconBtn(icons.redo, withShortcut('Redo', isApple ? 'Mod+Shift+Z' : 'Mod+Y'), () => this.redo());

    this.modeMenu = dropdown<BoardMode>({
      name: 'Mode',
      className: 'mode-btn',
      value: this.settings.mode,
      onSelect: (m) => this.setMode(m),
      options: [
        { value: 'strips', label: 'Strips', icon: icons.strip, hint: 'M', description: 'Unlock one strip to write; rest your palm anywhere else.' },
        { value: 'multi', label: 'Multi-strip', icon: icons.multi, hint: 'M', description: 'Unlock several strips at once for bigger drawings.' },
        { value: 'split', label: 'Split', icon: icons.split, description: 'Two panes, each locked or unlocked; the page scrolls under them. Tap the divider grip, then drag, to resize.' },
        { value: 'free', label: 'Free whiteboard', icon: icons.free, hint: 'F', description: 'The whole page takes ink. Two fingers scroll and zoom.' },
      ],
    });

    this.status = h('div', { class: 'status', title: '' });
    this.rotateBtn = this.iconBtn(icons.rotate, 'Rotate right', () => orientation.rotateRight(), 'rotate-btn');

    const toolbar = (this.toolbarEl = h(
      'header',
      { class: 'toolbar' },
      this.iconBtn(icons.menu, 'Notes', () => this.toggleSidebar()),
      this.titleInput,
      h('div', { class: 'sep' }),
      tools,
      this.swatches,
      this.sizeBtn,
      h('div', { class: 'sep' }),
      h('div', { class: 'group' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'sep' }),
      this.modeMenu.el,
      (this.stripControls = h(
        'div',
        { class: 'group strip-controls' },
        this.iconBtn(icons.up, withShortcut('Previous strip', 'Up'), () => this.board.stepLine(-1), 'step-btn'),
        this.iconBtn(icons.down, withShortcut('Next strip', 'Down'), () => this.board.stepLine(1), 'step-btn'),
        this.iconBtn(icons.lockAll, 'Lock all strips', () => this.board.lockAll()),
      )),
      h('div', { class: 'spacer' }),
      this.opts.signIn ? this.signInButton('toolbar') : null,
      this.status,
      this.rotateBtn,
      (this.historyBtn = this.iconBtn(icons.history, 'Version history', () => void this.openHistory())),
      (this.exportBtn = this.iconBtn(icons.download, 'Share or export', () => this.openExportMenu())),
      this.iconBtn(icons.gear, 'Settings', () => this.openSettings()),
    ));

    // Sidebar
    this.bookButton = h('button', { class: 'book-button', type: 'button', 'aria-expanded': 'false', title: 'Switch notebook' }) as HTMLButtonElement;
    this.bookButton.addEventListener('click', () => this.toggleBookPanel());
    this.bookPanel = h('div', { class: 'book-panel', hidden: true });
    this.noteList = h('ul', { class: 'note-list' });
    const newBtn = h('button', { class: 'btn primary', type: 'button' });
    newBtn.innerHTML = `${icons.plus}<span>New note</span>`;
    newBtn.addEventListener('click', () => void this.newNote(true));
    const importBtn = h('button', { class: 'btn import-btn', type: 'button', title: 'Import notes from a Lineboard file (.lbd) or a zip of them' });
    importBtn.innerHTML = `${icons.upload}<span>Import</span>`;
    importBtn.addEventListener('click', () => this.pickImport());
    this.sidebar = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'sidebar-head' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')), this.iconBtn(icons.close, 'Close', () => this.toggleSidebar(false))),
      this.searchButton(),
      h('div', { class: 'section-label' }, 'Notebook'),
      this.bookButton,
      this.bookPanel,
      h('div', { class: 'note-buttons' }, newBtn, importBtn),
      this.noteList,
      h(
        'div',
        { class: 'sidebar-foot' },
        // Name and picture, not the email: the sidebar is on screen in recordings and screen shares.
        (this.accountChip = h('button', { class: 'account-chip', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }) as HTMLButtonElement),
        h(
          'small',
          { class: 'foot-note' },
          this.opts.signIn
            ? 'Trying without an account: notes are saved in this browser only.'
            : this.store.mode === 'local'
              ? 'Local mode: notes stay on this device.'
              : 'Synced to your account.',
        ),
      ),
      this.opts.signIn ? this.signInButton('sidebar') : null,
    );
    this.accountChip.addEventListener('click', () => this.accountMenu());
    this.renderAccountChip();
    this.sidebar.append(this.resizeHandle());
    attachNameTips(this.sidebar, '.note-title, .book-title, .book-name');
    const scrim = h('div', { class: 'scrim' });
    scrim.addEventListener('click', () => this.toggleSidebar(false));

    // Board
    const boardHost = h('div', { class: 'board-host' });
    this.hint = h('div', { class: 'hint' });
    // The first-visit explanation matches the mode the page opens in (split, for new users).
    const how =
      this.settings.mode === 'split'
        ? 'write in the open half of the screen and rest your palm on the locked half. Tap a 🔒 in the margin to switch halves; drag the margin to scroll.'
        : 'tap a 🔒 in the margin to unlock one strip. Only that strip takes ink, so rest your palm anywhere else. Drag the margin to scroll.';
    this.hint.innerHTML = `<b>How it works:</b> ${how} <button type="button" class="link">Got it</button>`;
    this.hint.querySelector('button')!.addEventListener('click', () => {
      this.hint.remove();
      lsSet('lb-hint-dismissed', true);
    });

    const main = h('div', { class: 'main' }, this.sidebar, scrim, boardHost);
    if (!lsGet('lb-hint-dismissed', false)) boardHost.append(this.hint);

    this.appEl = h('div', { class: 'app' }, toolbar, main);
    this.root.replaceChildren(this.appEl);
    attachOrientation(this.appEl);
    const showRotate = () => (this.rotateBtn.hidden = !orientation.manual);
    showRotate();
    const off = orientation.onChange(showRotate);
    this.abort.signal.addEventListener('abort', () => off());

    // The board takes pointer presses without moving focus, so a field being edited (the note title)
    // would keep its caret. Pressing the board finishes the edit, as clicking anywhere else does.
    boardHost.addEventListener(
      'pointerdown',
      () => {
        const a = document.activeElement as HTMLElement | null;
        if (a && a.tagName === 'INPUT' && !boardHost.contains(a)) a.blur();
      },
      true,
    );

    this.board = new Board(boardHost, this.settings, {
      onStrokesAdded: (s) => this.record({ type: 'add', strokes: s }),
      onStrokesRemoved: (s) => this.record({ type: 'remove', strokes: s }),
      onStrokesReplaced: (from, to) => this.record({ type: 'replace', from, to }),
      // The format bar's last choices become the style for the next text box.
      onTextFormat: ({ style, size, color }) => {
        this.settings.textStyle = style;
        this.settings.textSize = size;
        this.settings.penColor = color;
        this.settingsChanged();
        this.renderToolOptions();
      },
      onContact: (size, type, accepted) => this.settingsPanel?.showContact(size, type, accepted),
      onUnlockChange: () => {},
      loadImage: (id, type) => this.store.getImage(id, type),
      onSplitRatio: (r) => {
        this.settings.splitRatio = r;
        this.settingsChanged();
      },
    });

    this.buildSettings();
    this.renderToolOptions();
    this.renderMode();
    this.renderUndo();
    this.bindKeys();
    this.bindPictures(boardHost);
  }

  private bindPictures(host: HTMLElement) {
    window.addEventListener(
      'paste',
      (e) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        void this.insertImages(files);
      },
      { signal: this.abort.signal },
    );
    host.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) {
        e.preventDefault();
        host.classList.add('drop-target');
      }
    });
    host.addEventListener('dragleave', () => host.classList.remove('drop-target'));
    host.addEventListener('drop', (e) => {
      host.classList.remove('drop-target');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      // A Lineboard file (or a zip of them) is imported; pictures are placed on the page.
      const notes = files.find((f) => /\.(lbd|zip)$/i.test(f.name));
      if (notes) void this.importFile(notes);
      else void this.insertImages(files);
    });
  }

  private bindKeys() {
    // Search works from anywhere, typing included (the title, a text box): caught before the board's
    // text box keeps the key to itself, and before the browser takes Ctrl+K for its address bar.
    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          e.stopPropagation();
          this.openSearch();
        }
      },
      { capture: true, signal: this.abort.signal },
    );
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || this.historyPanel) return; // already handled (an open menu, a text box...), or looking at history
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
        if (e.key === 's') this.setTool('shape');
        if (e.key === 't') this.setTool('text');
        if (e.key === 'v') this.setTool('select');
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.board.hasSelection()) {
          e.preventDefault();
          this.board.deleteSelection();
        }
        if (e.key === 'Escape') this.board.clearSelection();
        if (e.key === 'm' && this.settings.mode !== 'free') this.setMode(this.settings.mode === 'multi' ? 'strips' : 'multi');
        if (e.key === 'f') this.setMode(this.settings.mode === 'free' ? this.lastStripMode : 'free');
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

  /**
   * The sidebar's right edge can be dragged to make it wider or narrower, within limits so it never
   * covers most of the page: 240 px to 560 px, and at most 60% of the screen. Double-click (or
   * Home) puts it back; arrow keys move it in steps. Remembered on this device.
   */
  private resizeHandle() {
    const MIN = 240;
    const max = () => Math.max(MIN, Math.min(560, Math.floor(appViewport().width * 0.6)));
    const handle = h('div', { class: 'sidebar-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the sidebar', tabindex: '0', title: 'Drag to resize (double-click to reset)' });
    const apply = (w: number | null) => {
      if (w === null) {
        this.sidebar.style.removeProperty('--sidebar-w');
        handle.removeAttribute('aria-valuenow');
        return;
      }
      const v = Math.round(Math.min(max(), Math.max(MIN, w)));
      this.sidebar.style.setProperty('--sidebar-w', `${v}px`);
      handle.setAttribute('aria-valuenow', String(v));
      handle.setAttribute('aria-valuemin', String(MIN));
      handle.setAttribute('aria-valuemax', String(max()));
    };
    const save = () => lsSet('lb-sidebar-width', this.sidebar.style.getPropertyValue('--sidebar-w') ? parseInt(this.sidebar.style.getPropertyValue('--sidebar-w')) : null);
    const saved = lsGet<number | null>('lb-sidebar-width', null);
    if (typeof saved === 'number' && Number.isFinite(saved)) apply(saved);
    let drag: { id: number; x0: number; w0: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      // In the app's own coordinates: with the app turned 90°, the on-screen width is its height.
      drag = { id: e.pointerId, x0: clientToApp(e.clientX, e.clientY).x, w0: appRect(this.sidebar).width };
      this.sidebar.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (drag?.id === e.pointerId) apply(drag.w0 + clientToApp(e.clientX, e.clientY).x - drag.x0);
    });
    const end = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      this.sidebar.classList.remove('resizing');
      save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
      apply(null);
      save();
    });
    handle.addEventListener('keydown', (e) => {
      const w = appRect(this.sidebar).width;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') apply(w + (e.key === 'ArrowRight' ? 24 : -24));
      else if (e.key === 'Home') apply(null);
      else return;
      e.preventDefault();
      save();
    });
    // A smaller window (or turning the device) keeps the sidebar within the limit.
    window.addEventListener(
      'resize',
      () => {
        const cur = parseInt(this.sidebar.style.getPropertyValue('--sidebar-w'));
        if (cur) apply(cur);
      },
      { signal: this.abort.signal },
    );
    return handle;
  }

  private toggleSidebar(force?: boolean) {
    const open = force ?? !this.root.querySelector('.app')!.classList.contains('sidebar-open');
    this.root.querySelector('.app')!.classList.toggle('sidebar-open', open);
  }

  // ----------------------------- tools -----------------------------

  private setTool(t: Tool) {
    if (t === 'text' && this.store.supportsText) {
      // Older cloud databases can't store text boxes yet; ask once, then switch.
      void this.store.supportsText().then((ok) => {
        if (ok) this.useTool('text');
        else toast('Text boxes need a database update: the site operator re-runs supabase/schema.sql.', 'error');
      });
      return;
    }
    this.useTool(t);
  }

  private useTool(t: Tool) {
    this.tool = t;
    this.board.setTool(t);
    this.renderToolOptions();
  }

  /** Switch how the page takes ink. Strokes are unaffected; only how input is taken changes. */
  private setMode(m: BoardMode) {
    const was = this.settings.mode;
    if (m === was) return;
    if (was !== 'free') this.lastStripMode = was;
    this.settings.mode = m;
    this.settingsChanged();
    this.renderMode();
    toast(
      {
        strips: was === 'multi' ? 'Strips: all locked. Tap a lock in the margin to write.' : 'Strips: tap a lock in the margin to write.',
        multi: 'Multi-strip: tap several locks to unlock them together.',
        split: 'Split: tap a pane’s lock to lock or unlock it. Tap the divider grip in the margin, then drag, to move it.',
        free: 'Free whiteboard: write anywhere. Two fingers scroll and pinch to zoom.',
      }[m],
    );
  }

  private renderMode() {
    this.modeMenu.set(this.settings.mode);
    this.stripControls.hidden = this.settings.mode === 'free';
    // Previous / next strip mean nothing when the screen is split into two fixed panes.
    for (const b of this.stripControls.querySelectorAll<HTMLElement>('.step-btn')) b.hidden = this.settings.mode === 'split';
    if (this.settings.mode !== 'free') this.lastStripMode = this.settings.mode;
  }

  private renderToolOptions() {
    for (const [t, b] of this.toolBtns) b.classList.toggle('active', t === this.tool);
    this.shapeTool.classList.toggle('active', this.tool === 'shape');
    this.shapeMain.innerHTML = SHAPE_ICONS[this.settings.shape];
    this.shapeMain.setAttribute('aria-label', `Shapes: ${SHAPE_NAMES[this.settings.shape]}`);
    this.shapeMain.title = withShortcut(`Shapes: ${SHAPE_NAMES[this.settings.shape]}`, 'S');
    this.selectMenu.el.classList.toggle('active', this.tool === 'select');
    this.selectMenu.set(this.settings.selectMode);
    const isHL = this.tool === 'highlighter';
    const colors = isHL ? HL_COLORS : PEN_COLORS;
    const cur = isHL ? this.settings.highlighterColor : this.settings.penColor;
    const pick = (c: string) => {
      if (isHL) this.settings.highlighterColor = c;
      else this.settings.penColor = c;
      if (this.tool === 'eraser' || this.tool === 'select') this.setTool('pen');
      this.settingsChanged();
      this.renderToolOptions();
    };
    const swatch = (c: string) => {
      const on = c.toLowerCase() === cur.toLowerCase();
      const b = h('button', { class: 'swatch' + (on ? ' active' : ''), type: 'button', 'aria-label': 'Color ' + c, 'aria-pressed': String(on), title: c });
      b.style.setProperty('--c', c);
      // The chosen colour: a ring around it and a check inside, light or dark to stand out on it.
      if (on) {
        b.innerHTML = icons.check;
        b.style.setProperty('--tick', isLight(c) ? '#111827' : '#ffffff');
      }
      b.addEventListener('click', () => pick(c));
      return b;
    };
    // A colour chosen with the picker shows as its own swatch after the palette.
    const custom = colors.some((c) => c.toLowerCase() === cur.toLowerCase()) ? null : swatch(cur);
    const picker = h('input', { type: 'color', class: 'color-input', 'aria-label': 'Custom colour', tabindex: '-1' }) as HTMLInputElement;
    picker.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000';
    picker.addEventListener('input', () => pick(picker.value));
    const more = h('label', { class: 'swatch-more', title: 'Custom colour' }, picker);
    more.insertAdjacentHTML('beforeend', icons.plus);
    this.swatches.replaceChildren(...colors.map(swatch), ...(custom ? [custom] : []), more);
    this.renderSizeButton();
    const hide = this.tool === 'eraser' || this.tool === 'select';
    this.swatches.style.display = hide ? 'none' : '';
    this.sizeBtn.style.display = hide ? 'none' : '';
  }

  /** The size of the tool in use: pen, highlighter, text, or shape outline thickness. */
  private get sizeTool(): 'pen' | 'highlighter' | 'text' | 'shape' {
    return this.tool === 'highlighter' || this.tool === 'text' || this.tool === 'shape' ? this.tool : 'pen';
  }
  private get size() {
    return { pen: this.settings.penWidth, highlighter: this.settings.highlighterWidth, text: this.settings.textSize, shape: this.settings.shapeWidth }[this.sizeTool];
  }
  private set size(w: number) {
    if (this.sizeTool === 'highlighter') this.settings.highlighterWidth = w;
    else if (this.sizeTool === 'text') this.settings.textSize = w;
    else if (this.sizeTool === 'shape') this.settings.shapeWidth = w;
    else this.settings.penWidth = w;
  }
  private get sizeName() {
    return { pen: 'Pen', highlighter: 'Highlighter', text: 'Text', shape: 'Shape outline' }[this.sizeTool];
  }

  /** Toolbar button: a dot drawn at the current size (capped so it fits). */
  private renderSizeButton() {
    const { min, max } = SIZES[this.sizeTool];
    const w = this.size;
    const px = 4 + ((w - min) / (max - min)) * 16;
    this.sizeBtn.innerHTML = '';
    const dot = h('i', { class: 'size-dot' });
    dot.style.width = dot.style.height = `${px}px`;
    if (this.sizeTool === 'highlighter') dot.style.background = this.settings.highlighterColor;
    else dot.style.background = this.settings.penColor;
    this.sizeBtn.append(dot);
    const label = `${this.sizeName} size: ${w}`;
    this.sizeBtn.setAttribute('aria-label', label);
    this.sizeBtn.title = label;
  }

  private openSizePicker() {
    if (this.sizeBtn.getAttribute('aria-expanded') === 'true') {
      closeOpenMenu();
      return;
    }
    const tool = this.sizeTool;
    const cfg = SIZES[tool];
    const isHL = tool === 'highlighter';
    const color = isHL ? this.settings.highlighterColor : this.settings.penColor;
    const slider = h('input', { type: 'range', min: String(cfg.min), max: String(cfg.max), step: String(cfg.step), 'aria-label': `${this.sizeName} size` }) as HTMLInputElement;
    slider.value = String(this.size);
    const value = h('output', { class: 'size-value' });
    const preview = h('canvas', { class: 'size-preview', width: '440', height: '90', 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const draw = () => {
      const ctx = preview.getContext('2d')!;
      const w = Number(slider.value);
      value.textContent = String(w);
      ctx.clearRect(0, 0, preview.width, preview.height);
      // Same scale as the board, so the preview matches what you will get on this screen.
      const k = (document.querySelector('.canvas-area')?.clientWidth ?? PAGE_W) / PAGE_W;
      ctx.save();
      ctx.scale(2, 2); // canvas is drawn at 2x for sharpness
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      if (tool === 'text') {
        ctx.fillStyle = color;
        ctx.font = `${Math.min(40, w * k)}px ${TEXT_FONT}`;
        ctx.textBaseline = 'middle';
        ctx.fillText('Aa', 18, 23);
        ctx.restore();
        return;
      }
      ctx.lineWidth = Math.max(0.5, w * k);
      if (isHL) ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.moveTo(18, 30);
      ctx.bezierCurveTo(70, 5, 110, 45, 160, 22);
      ctx.bezierCurveTo(185, 12, 200, 20, 205, 24);
      ctx.stroke();
      ctx.restore();
    };
    const set = (w: number) => {
      slider.value = String(w);
      this.size = w;
      this.settingsChanged();
      this.renderSizeButton();
      for (const b of presets.children) b.classList.toggle('active', Number((b as HTMLElement).dataset.w) === w);
      draw();
    };
    slider.addEventListener('input', () => set(Number(slider.value)));
    const presets = h(
      'div',
      { class: 'size-presets' },
      ...cfg.presets.map((w, i) => {
        const names = tool === 'shape' ? LINE_WIDTHS.map((x) => x.name) : ['Thin', 'Medium', 'Thick'];
        const b = h('button', { class: 'btn' + (w === this.size ? ' active' : ''), type: 'button', 'data-w': String(w) }, names[i]);
        b.addEventListener('click', () => set(w));
        return b;
      }),
    );
    draw();
    popover(this.sizeBtn, h('div', { class: 'size-picker' }, preview, h('div', { class: 'range' }, slider, value), presets), { label: `${this.sizeName} size` });
  }

  /** Add pictures to the page: save each, then place it in view and select it (to move or resize). */
  private async insertImages(files: File[]) {
    let pics = files.filter((f) => f.type.startsWith('image/'));
    if (!pics.length) return;
    if (pics.length > MAX_PICTURES_AT_ONCE) {
      toast(`Adding the first ${MAX_PICTURES_AT_ONCE} pictures (at most ${MAX_PICTURES_AT_ONCE} at a time).`, 'error');
      pics = pics.slice(0, MAX_PICTURES_AT_ONCE);
    }
    await this.ready; // a picture pasted right after the page opened waits for the note
    if (!this.current) return toast('Open a note first.', 'error');
    let last: Stroke | null = null;
    // A placeholder for each picture shows at once, where it will land, until it is saved.
    const slots = pics.map(() => this.board.addPending());
    this.picturesInFlight += pics.length;
    this.renderStatus();
    for (const [i, file] of pics.entries()) {
      try {
        const img = await prepareImage(file);
        const bitmap = await createImageBitmap(img.blob);
        this.board.sizePending(slots[i], bitmap.width, bitmap.height);
        const id = uuid();
        await this.store.putImage(id, img.blob);
        last = this.board.insertImage(id, img.type, bitmap, slots[i]);
      } catch (e) {
        toast('Could not add the picture: ' + (e as Error).message, 'error');
      } finally {
        this.board.removePending(slots[i]);
        this.picturesInFlight--;
        this.renderStatus();
      }
    }
    if (last) {
      this.setTool('select');
      this.board.select([last.id]);
    }
  }

  /** The shape palette: a grid of shapes, and a switch for perfect squares / circles. */
  private openShapePalette() {
    if (this.shapeBtn.getAttribute('aria-expanded') === 'true') {
      closeOpenMenu();
      return;
    }
    const grid = h('div', { class: 'shape-grid', role: 'radiogroup', 'aria-label': 'Shape' });
    let close = () => {};
    for (const k of SHAPES) {
      const b = h('button', { class: 'shape-cell', type: 'button', role: 'radio', 'aria-checked': String(k === this.settings.shape), 'aria-label': SHAPE_NAMES[k], title: SHAPE_NAMES[k] });
      b.innerHTML = SHAPE_ICONS[k];
      b.addEventListener('click', () => {
        this.settings.shape = k;
        this.settingsChanged();
        this.setTool('shape');
        close();
      });
      grid.append(b);
    }
    const lock = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': 'Keep proportions' }) as HTMLButtonElement;
    lock.append(h('i', { class: 'knob' }));
    const paint = () => {
      lock.classList.toggle('on', this.settings.shapeLock);
      lock.setAttribute('aria-checked', String(this.settings.shapeLock));
    };
    paint();
    lock.addEventListener('click', () => {
      this.settings.shapeLock = !this.settings.shapeLock;
      this.settingsChanged();
      paint();
    });
    const foot = h(
      'div',
      { class: 'shape-foot' },
      h('b', {}, 'Keep proportions'),
      lock,
    );
    ({ close } = popover(this.shapeBtn, h('div', { class: 'shape-palette' }, grid, this.lineOptions(), foot), { label: 'Shapes' }));
  }

  /** Line style (solid, dashed, dotted) and thickness for shapes: two rows of icon choices. */
  private lineOptions() {
    const line = (attrs: string) =>
      `<svg viewBox="0 0 32 16" width="32" height="16" aria-hidden="true"><path d="M3 8h26" fill="none" stroke="currentColor" stroke-linecap="round" ${attrs}/></svg>`;
    const group = <T>(label: string, items: { value: T; name: string; icon: string }[], get: () => T, set: (v: T) => void) => {
      const row = h('div', { class: 'line-choices', role: 'radiogroup', 'aria-label': label });
      const paint = () => row.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => b.setAttribute('aria-checked', String(items[i].value === get())));
      for (const it of items) {
        const b = h('button', { class: 'line-choice', type: 'button', role: 'radio', 'aria-label': it.name, title: it.name });
        b.innerHTML = it.icon;
        b.addEventListener('click', () => {
          set(it.value);
          this.settingsChanged();
          paint();
        });
        row.append(b);
      }
      paint();
      return row;
    };
    const dashAttr = { solid: '', dashed: 'stroke-dasharray="6 5"', dotted: 'stroke-dasharray="0 5"' };
    return h(
      'div',
      { class: 'line-options' },
      group(
        'Line style',
        LINE_STYLES.map((v) => ({ value: v, name: LINE_STYLE_NAMES[v], icon: line(`stroke-width="2.4" ${dashAttr[v]}`) })),
        () => this.settings.shapeDash,
        (v) => (this.settings.shapeDash = v),
      ),
      group(
        'Thickness',
        LINE_WIDTHS.map((w) => ({ value: w.width as number, name: w.name, icon: line(`stroke-width="${Math.min(7, 1 + w.width * 0.6).toFixed(1)}"`) })),
        () => this.settings.shapeWidth,
        (v) => {
          this.settings.shapeWidth = v;
          this.renderSizeButton(); // the toolbar's size button shows the same thickness
        },
      ),
    );
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
    if (a.type === 'replace') {
      if (toBoard) {
        this.board.removeStrokes(a.from.map((s) => s.id));
        this.board.addStrokes(a.to);
      }
      this.queue.remove(a.from.map((s) => s.id));
      this.queue.upsert(a.to);
    } else if (a.type === 'add') {
      if (toBoard) this.board.addStrokes(a.strokes);
      this.queue.upsert(a.strokes);
    } else {
      if (toBoard) this.board.removeStrokes(a.strokes.map((s) => s.id));
      this.queue.remove(a.strokes.map((s) => s.id));
    }
    this.bumpCurrent();
    if (this.current) this.history.changed(this.current.id);
  }

  private invert(a: Action): Action {
    if (a.type === 'replace') return { type: 'replace', from: a.to, to: a.from };
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

  /** Pictures still being prepared and uploaded: the status says "Saving..." until they are done. */
  private picturesInFlight = 0;
  private syncState: SyncState = 'saved';

  private renderStatus() {
    const s: SyncState = this.picturesInFlight && this.syncState === 'saved' ? 'saving' : this.syncState;
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
    return this.notes.filter((n) => n.notebook_id === id && !n.archived_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Notebooks not archived: starred first, then in the order they were made. */
  private activeBooks(): Notebook[] {
    return this.notebooks.filter((b) => !b.archived_at).sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || a.created_at.localeCompare(b.created_at));
  }

  /** Starred notes from every notebook that is not archived, most recently changed first. */
  private starredNotes(): NoteMeta[] {
    const active = new Set(this.activeBooks().map((b) => b.id));
    return this.notes.filter((n) => n.starred && !n.archived_at && n.notebook_id && active.has(n.notebook_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  private renderNoteList() {
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const books = new Map(this.notebooks.map((b) => [b.id, b.name]));
    const row = (n: NoteMeta, starredList: boolean) => {
      const active = n.id === this.current?.id;
      // In "Starred", a note from another notebook says which one it is in.
      const sub = starredList && n.notebook_id !== this.currentBook?.id ? (books.get(n.notebook_id ?? '') ?? '') : fmt.format(new Date(n.updated_at));
      const open = h('button', { class: 'note-open', type: 'button' }, h('span', { class: 'note-title' }, n.title || 'Untitled'), h('span', { class: 'note-date' }, sub));
      open.addEventListener('click', () => {
        void this.openFromList(n);
        if (window.innerWidth < 900) this.toggleSidebar(false);
      });
      const more = this.iconBtn(icons.more, `More for "${n.title || 'Untitled'}"`, () => this.noteMenu(n, more), 'small more-btn');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      return h('li', { class: active ? 'active' : '' }, open, h('div', { class: 'note-actions' }, this.starButton('note', n), more));
    };
    // A starred note shows once, under "Starred", not again in its notebook's list.
    const starred = this.starredNotes();
    const notes = this.visibleNotes().filter((n) => !n.starred);
    this.noteList.replaceChildren(
      ...(starred.length ? [h('li', { class: 'list-label', role: 'presentation' }, 'Starred'), ...starred.map((n) => row(n, true)), h('li', { class: 'list-label', role: 'presentation' }, 'Notes')] : []),
      ...notes.map((n) => row(n, false)),
    );
    this.renderNotebooks(); // keep the per-notebook note counts current
  }

  /** A star toggle for a note or notebook row. */
  private starButton(kind: 'note' | 'notebook', item: NoteMeta | Notebook) {
    const name = 'title' in item ? item.title || 'Untitled' : item.name;
    const b = this.iconBtn(item.starred ? icons.starFilled : icons.star, item.starred ? `Unstar "${name}"` : `Star "${name}"`, () => void this.setFlags(kind, item, { starred: !item.starred }), 'small star-btn' + (item.starred ? ' on' : ''));
    b.setAttribute('aria-pressed', String(!!item.starred));
    return b;
  }

  // ----------------------------- profile -----------------------------

  private profile: Profile = { ...EMPTY_PROFILE };
  /** The profile picture as an object URL (null: none, or not readable here). */
  private profileUrl: string | null = null;
  private accountChip!: HTMLButtonElement;

  private async loadProfile(p?: Profile) {
    try {
      this.profile = p ?? (await this.store.loadProfile());
      const blob = await this.store.loadProfilePicture(this.profile);
      if (this.profileUrl) URL.revokeObjectURL(this.profileUrl);
      this.profileUrl = blob ? URL.createObjectURL(blob) : null;
    } catch (e) {
      console.warn('Profile not loaded', e);
    }
    this.renderAccountChip();
  }

  private renderAccountChip() {
    const name = this.profile.name;
    this.accountChip.replaceChildren(avatar(this.profile, this.profileUrl, 32), h('span', { class: 'account-name' + (name ? '' : ' empty') }, name || 'Add your name'));
    this.accountChip.insertAdjacentHTML('beforeend', icons.more);
    this.accountChip.setAttribute('aria-label', `${name || 'Your profile'}: account menu`);
  }

  private accountMenu() {
    actionMenu(this.accountChip, 'Account', [
      { label: 'Profile', icon: icons.user, run: () => this.settingsPanel.open('account') },
      { label: 'Data controls', icon: icons.archive, run: () => this.settingsPanel.open('data') },
      { label: 'Settings', icon: icons.gear, run: () => this.openSettings() },
      ...(this.opts.signOut
        ? [{
            label: 'Sign out',
            icon: icons.close,
            run: async () => {
              if (this.queue.pending && !(await dialog({ title: 'Unsaved changes', message: 'Some strokes are still being saved. Sign out anyway?', ok: 'Sign out', danger: true }))) return;
              await this.opts.signOut!();
            },
          }]
        : []),
    ]);
  }

  /** Change the name or picture (from Settings). */
  private async changeProfile(change: { name?: string; picture?: File | null }) {
    const picture = change.picture ? await squarePicture(change.picture) : change.picture;
    const saved = await this.store.saveProfile({ ...(change.name !== undefined ? { name: change.name } : {}), ...(picture !== undefined ? { picture } : {}) });
    await this.loadProfile(saved);
  }

  // ----------------------------- search -----------------------------

  private searchButton() {
    const b = h('button', { class: 'search-btn', type: 'button', title: withShortcut('Search notes and notebooks', 'Mod+K') });
    b.innerHTML = `${icons.search}<span>Search</span><kbd></kbd>`;
    b.querySelector('kbd')!.textContent = isApple ? '⌘K' : 'Ctrl K';
    b.addEventListener('click', () => this.openSearch());
    return b;
  }

  private openSearch() {
    if (document.querySelector('.search-modal') || this.historyPanel) return;
    this.board.finishText();
    openSearch({
      notes: () => this.notes,
      notebooks: () => this.notebooks,
      openNote: async (n) => {
        await this.openFromList(n);
        if (window.innerWidth < 900) this.toggleSidebar(false);
      },
      openNotebook: async (b) => {
        if (b.id !== this.currentBook?.id) await this.switchNotebook(b);
        this.toggleSidebar(true);
      },
      restore: async (kind, item) => {
        const name = 'title' in item ? item.title || 'Untitled' : item.name;
        // A note may be archived itself, in an archived notebook, or both: bring back what is needed.
        const book = 'notebook_id' in item ? this.notebooks.find((b) => b.id === item.notebook_id && b.archived_at) : undefined;
        const what = kind === 'note' && !item.archived_at ? `It is in the archived notebook “${book?.name}”.` : book ? `It and its notebook “${book.name}” are archived.` : `This ${kind} is archived.`;
        const ok = await dialog({ title: `Restore “${name}”?`, message: `${what} Restore to open it?`, ok: 'Restore and open' });
        if (!ok) return false;
        if (item.archived_at) await this.unarchive(kind, item.id);
        if (book) await this.unarchive('notebook', book.id);
        return !item.archived_at && !book?.archived_at;
      },
    });
  }

  /** Open a note from the list (a starred one may be in another notebook). */
  private async openFromList(n: NoteMeta) {
    const book = this.notebooks.find((b) => b.id === n.notebook_id);
    if (book && book.id !== this.currentBook?.id) await this.switchNotebook(book, n);
    else await this.openNote(n);
  }

  private noteMenu(n: NoteMeta, anchor: HTMLElement) {
    actionMenu(anchor, `Actions for "${n.title || 'Untitled'}"`, [
      { label: 'Rename', icon: icons.edit, run: () => void this.promptRename(n) },
      { label: 'Move to notebook', icon: icons.move, run: () => void this.moveNote(n) },
      { label: 'Share', icon: icons.share, run: () => void this.shareNote(n) },
      { label: 'Export (.lbd)', icon: icons.download, run: () => void this.exportNote(n) },
      { label: 'Archive', icon: icons.archive, run: () => void this.archive('note', n) },
      { label: 'Delete', icon: icons.trash, danger: true, run: () => void this.deleteNote(n) },
    ]);
  }

  private notebookMenu(nb: Notebook, anchor: HTMLElement) {
    actionMenu(anchor, `Actions for "${nb.name}"`, [
      { label: 'Rename', icon: icons.edit, run: () => void this.renameNotebook(nb) },
      { label: 'Share', icon: icons.share, run: () => void this.shareNotebook(nb) },
      { label: 'Export (.lbd)', icon: icons.download, run: () => void this.exportNotebook(nb) },
      { label: 'Archive', icon: icons.archive, run: () => void this.archive('notebook', nb) },
      { label: 'Delete', icon: icons.trash, danger: true, run: () => void this.deleteNotebook(nb) },
    ]);
  }

  // ----------------------------- stars and the archive -----------------------------

  /** Star, unstar, archive or restore a note or notebook; shown at once, put back if saving fails. */
  private async setFlags(kind: 'note' | 'notebook', item: NoteMeta | Notebook, flags: Flags) {
    const before: Flags = { starred: item.starred, archived_at: item.archived_at ?? null };
    Object.assign(item, flags);
    this.renderNoteList();
    try {
      await (kind === 'note' ? this.store.setNoteFlags(item.id, flags) : this.store.setNotebookFlags(item.id, flags));
      return true;
    } catch (e) {
      Object.assign(item, before);
      this.renderNoteList();
      toast((e as Error).message, 'error');
      return false;
    }
  }

  /** Archive: out of the sidebar and search, kept in Settings > Data controls until restored. */
  private async archive(kind: 'note' | 'notebook', item: NoteMeta | Notebook) {
    if (kind === 'notebook' && this.activeBooks().length <= 1) return toast('Keep at least one notebook: make another one first, then archive this.', 'error');
    if (!(await this.setFlags(kind, item, { archived_at: new Date().toISOString() }))) return;
    const name = 'title' in item ? item.title || 'Untitled' : item.name;
    if (kind === 'note' && this.current?.id === item.id) {
      this.current = null;
      const next = this.visibleNotes()[0];
      if (next) await this.openNote(next);
      else await this.newNote();
    }
    if (kind === 'notebook' && this.currentBook?.id === item.id) {
      this.current = null;
      await this.switchNotebook(this.activeBooks()[0]);
    }
    this.renderNoteList();
    toast(`Archived "${name}". Find it in Settings > Data controls.`);
  }

  private async unarchive(kind: 'note' | 'notebook', id: string) {
    const item = kind === 'note' ? this.notes.find((n) => n.id === id) : this.notebooks.find((b) => b.id === id);
    if (!item) return;
    if (await this.setFlags(kind, item, { archived_at: null })) toast(`Restored "${'title' in item ? item.title || 'Untitled' : item.name}".`);
  }

  /** The note whose strokes are on the board (null while one is loading). */
  private loadedNote: string | null = null;

  private async openNote(n: NoteMeta) {
    const token = ++this.loadToken;
    this.historyPanel?.close();
    // Leaving a note: its changes get their version now (from what was on the board).
    if (this.current && this.loadedNote === this.current.id && this.current.id !== n.id) {
      this.board.finishText();
      this.history.leave(this.current.id, this.board.allStrokes());
    }
    this.loadedNote = null;
    this.current = n;
    this.titleInput.value = n.title;
    lsSet(this.lsKey('last-note'), n.id);
    this.undoStack = [];
    this.redoStack = [];
    this.renderUndo();
    this.renderNoteList();
    this.board.setStrokes(n.id, []);
    this.board.setLoading(true);
    try {
      const loaded = await this.store.loadStrokes(n.id);
      if (token !== this.loadToken) return;
      const strokes = this.queue.overlay(n.id, loaded);
      this.board.setStrokes(n.id, strokes);
      this.loadedNote = n.id;
      void this.history.opened(n.id, strokes);
    } catch (e) {
      if (token !== this.loadToken) return;
      // Offline: show whatever is still waiting to be saved for this note.
      this.board.setStrokes(n.id, this.queue.overlay(n.id, []));
      toast('Could not load this note: ' + (e as Error).message, 'error');
    } finally {
      if (token === this.loadToken) this.board.setLoading(false);
    }
  }

  /**
   * Create a note. Asked for by the user (`ask`): name it first, starting from the default name,
   * selected so typing replaces it. Made by the app (a notebook with no notes left): the default.
   */
  private async newNote(ask = false) {
    const d = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
    let title = `Note ${d}`;
    if (ask) {
      const name = await dialog({ title: 'New note', input: title, ok: 'Create', maxLength: MAX_NOTE_TITLE });
      if (name === null) return;
      title = clip(name, MAX_NOTE_TITLE) || title;
    }
    try {
      if (!this.currentBook) return;
      const n = await this.store.createNote(title, this.currentBook.id);
      this.notes.unshift(n);
      await this.openNote(n);
    } catch (e) {
      toast('Could not create note: ' + (e as Error).message, 'error');
    }
  }

  private async renameCurrent(title: string) {
    if (!this.current) return;
    const t = clip(title, MAX_NOTE_TITLE) || 'Untitled';
    await this.rename(this.current, t);
  }

  private async promptRename(n: NoteMeta) {
    const t = await dialog({ title: 'Rename note', input: n.title, ok: 'Rename', maxLength: MAX_NOTE_TITLE });
    if (t === null) return;
    await this.rename(n, clip(t, MAX_NOTE_TITLE) || 'Untitled');
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
      this.history.forget(n.id);
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
    for (const n of this.notes) if (n.archived_at && n.notebook_id) counts.set(n.notebook_id, (counts.get(n.notebook_id) ?? 1) - 1);
    const items = this.activeBooks().map((nb) => {
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
      const more = this.iconBtn(icons.more, `More for "${nb.name}"`, () => this.notebookMenu(nb, more), 'small more-btn');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      return h('li', { class: nb.id === b?.id ? 'active' : '' }, open, h('div', { class: 'note-actions' }, this.starButton('notebook', nb), more));
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
    const name = await dialog({ title: 'New notebook', input: `Notebook ${this.notebooks.length + 1}`, ok: 'Create', maxLength: MAX_NOTEBOOK_NAME });
    if (name === null) return;
    try {
      const b = await this.store.createNotebook(clip(name, MAX_NOTEBOOK_NAME) || 'Untitled notebook');
      this.notebooks.push(b);
      this.toggleBookPanel(false);
      await this.switchNotebook(b);
    } catch (e) {
      toast('Could not create notebook: ' + (e as Error).message, 'error');
    }
  }

  private async renameNotebook(b: Notebook) {
    const name = await dialog({ title: 'Rename notebook', input: b.name, ok: 'Rename', maxLength: MAX_NOTEBOOK_NAME });
    if (name === null) return;
    const old = b.name;
    b.name = clip(name, MAX_NOTEBOOK_NAME) || 'Untitled notebook';
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
      if (!this.activeBooks().length) this.notebooks = [...this.notebooks, await this.store.createNotebook('My Notebook')];
      if (this.currentBook?.id === b.id) {
        this.current = null;
        await this.switchNotebook(this.activeBooks()[0]);
      } else this.renderNoteList();
    } catch (e) {
      toast('Delete failed: ' + (e as Error).message, 'error');
    }
  }

  private async moveNote(n: NoteMeta) {
    const others = this.activeBooks().filter((b) => b.id !== n.notebook_id);
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

  /** Save a file the browser downloads. */
  private download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ----------------------------- Lineboard files (.lbd) -----------------------------

  // ----------------------------- version history -----------------------------

  private async openHistory() {
    if (this.historyPanel) return this.historyPanel.close();
    await this.ready;
    const note = this.current;
    if (!note || this.loadedNote !== note.id) return toast('Open a note first.', 'error');
    if (!(await this.history.enabled)) return toast(HISTORY_NEEDS_UPDATE, 'error');
    this.board.finishText();
    this.toggleSidebar(false);
    this.historyBtn.classList.add('active');
    this.historyPanel = new HistoryPanel(
      {
        store: this.store,
        board: this.board,
        recorder: this.history,
        setBusy: (on) => {
          this.toolbarEl.inert = on;
          this.sidebar.inert = on;
          this.appEl.classList.toggle('history-open', on);
        },
        replaceStrokes: (remove, add) => {
          const a: Action = { type: 'replace', from: remove, to: add.map((s) => ({ ...s, note_id: note.id })) };
          this.undoStack.push(a);
          this.redoStack = [];
          this.apply(a, true);
          this.renderUndo();
        },
        createNote: async (source, title, strokes) => {
          const book = source.notebook_id ?? this.currentBook?.id;
          if (!book) throw new Error('Open a notebook first.');
          const n = await this.store.createNote(title, book);
          // The copy's strokes keep their order: their times stay as they were.
          await this.store.upsertStrokes(strokes.map((s) => ({ ...s, note_id: n.id })));
          this.notes.unshift(n);
          this.renderNoteList();
          return n;
        },
        openNote: (n) => this.openNote(n),
      },
      note,
      this.appEl.querySelector('.main')!,
      () => {
        this.historyPanel = null;
        this.historyBtn.classList.remove('active');
      },
    );
  }

  private exportBtn!: HTMLButtonElement;

  /** The toolbar's export button: this note as a picture, or as a Lineboard file. */
  private openExportMenu() {
    if (this.exportBtn.getAttribute('aria-expanded') === 'true') {
      closeOpenMenu();
      return;
    }
    let close = () => {};
    const item = (label: string, sub: string, fn: () => void) => {
      const b = h('button', { class: 'export-item', type: 'button' }, h('b', {}, label), h('small', {}, sub));
      b.addEventListener('click', () => {
        close();
        fn();
      });
      return b;
    };
    const current = this.current;
    ({ close } = popover(
      this.exportBtn,
      h(
        'div',
        { class: 'export-menu' },
        item('Share…', 'As a PDF, picture or Lineboard file, from your device', () => current && void this.shareNote(current)),
        item('Picture (.png)', 'This page as an image', () => void this.exportPNG()),
        item(`Lineboard file (${LBD_EXT})`, 'This note, to keep or import elsewhere', () => current && void this.exportNote(current)),
      ),
      { label: 'Share or export' },
    ));
  }

  /** Make an .lbd from notebooks of notes and download it. */
  private async exportLbd(groups: { notebook: Notebook; notes: NoteMeta[] }[], name: string, withHistory = false) {
    try {
      this.board.finishText();
      const count = groups.reduce((n, g) => n + g.notes.length, 0);
      if (!count) return toast('There are no notes to export.', 'error');
      toast(count > 1 ? `Exporting ${count} notes...` : 'Exporting...');
      const { blob, missingPictures } = await buildLbd(this.store, groups, (id, saved) => this.queue.overlay(id, saved), undefined, withHistory);
      this.download(blob, fileName(name));
      if (missingPictures) toast(missingNote(missingPictures), 'error');
    } catch (e) {
      toast('Export failed: ' + (e as Error).message, 'error');
    }
  }

  // ----------------------------- sharing (as a file) -----------------------------

  /**
   * Share a file through the device's share menu (messages, mail, drive...) where the browser can;
   * otherwise download it to send it any other way. Lineboard never hosts what is shared.
   */
  private async sendFile(file: File) {
    const data = { files: [file], title: file.name };
    if (navigator.canShare?.(data)) {
      try {
        await navigator.share(data);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast('Could not share: ' + (e as Error).message, 'error');
      }
      return;
    }
    this.download(file, file.name);
    toast(`Downloaded “${file.name}”. Send it however you like; Lineboard files can be imported with Notes > Import.`);
  }

  /** Share a note: the open one as a PDF, picture or Lineboard file; another one as a Lineboard file. */
  private async shareNote(n: NoteMeta) {
    const open = n.id === this.current?.id && this.loadedNote === n.id;
    const kind = open
      ? await dialog({
          title: `Share “${n.title || 'Untitled'}”`,
          message: 'As a PDF or picture anyone can open, or as a Lineboard file they can import and keep editing. It is sent from your device; nothing is uploaded for sharing.',
          choices: [
            { value: 'pdf', label: 'PDF' },
            { value: 'png', label: 'Picture (.png)' },
            { value: 'lbd', label: `Lineboard file (${LBD_EXT})` },
          ],
          ok: 'Share',
        })
      : 'lbd';
    if (!kind) return;
    try {
      this.board.finishText();
      const name = n.title || 'Untitled';
      if (kind === 'lbd') {
        const book = this.notebooks.find((b) => b.id === n.notebook_id) ?? this.currentBook;
        if (!book) return;
        const { blob, missingPictures } = await buildLbd(this.store, [{ notebook: book, notes: [n] }], (id, saved) => this.queue.overlay(id, saved));
        await this.sendFile(new File([blob], fileName(name), { type: blob.type }));
        if (missingPictures) toast(missingNote(missingPictures), 'error');
      } else if (kind === 'png') {
        await this.sendFile(new File([await this.board.exportPNG()], fileName(name, '.png'), { type: 'image/png' }));
      } else {
        const pdf = await canvasToPdf(await this.board.renderPage(), name);
        await this.sendFile(new File([pdf], fileName(name, '.pdf'), { type: 'application/pdf' }));
      }
    } catch (e) {
      toast('Could not share: ' + (e as Error).message, 'error');
    }
  }

  /** Share a notebook: its notes (not archived ones) as one Lineboard file. */
  private async shareNotebook(nb: Notebook) {
    const notes = this.notes.filter((n) => n.notebook_id === nb.id && !n.archived_at);
    if (!notes.length) return toast('This notebook has no notes to share.', 'error');
    try {
      this.board.finishText();
      const { blob, missingPictures } = await buildLbd(this.store, [{ notebook: nb, notes }], (id, saved) => this.queue.overlay(id, saved));
      await this.sendFile(new File([blob], fileName(nb.name), { type: blob.type }));
      if (missingPictures) toast(missingNote(missingPictures), 'error');
    } catch (e) {
      toast('Could not share: ' + (e as Error).message, 'error');
    }
  }

  private async exportNote(n: NoteMeta) {
    const book = this.notebooks.find((b) => b.id === n.notebook_id) ?? this.currentBook;
    if (book) await this.exportLbd([{ notebook: book, notes: [n] }], n.title || 'Untitled');
  }

  private async exportNotebook(nb: Notebook) {
    await this.exportLbd([{ notebook: nb, notes: this.notes.filter((n) => n.notebook_id === nb.id && !n.archived_at) }], nb.name);
  }

  /** Every notebook and note in one file. Signed in, it asks who you are first (like Download my data). */
  private async exportAll() {
    const account = this.opts.account;
    if (account && !(await confirmItsYou(account, this.user.email, 'Exporting all your notes gives a copy of everything in them.'))) return;
    await this.exportLbd(
      this.notebooks.map((notebook) => ({ notebook, notes: this.notes.filter((n) => n.notebook_id === notebook.id) })),
      `Lineboard notes ${new Date().toISOString().slice(0, 10)}`,
      true, // a backup: with each note's version history
    );
  }

  /** Choose a Lineboard file (.lbd) or a zip of them to import. */
  private pickImport() {
    const input = h('input', { type: 'file', accept: `${LBD_EXT},.zip,application/zip`, hidden: true }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (f) void this.importFile(f);
    });
    document.body.append(input);
    input.click();
  }

  /** Import the notes in a file as new notes (nothing existing is changed), then open the first one. */
  async importFile(file: File) {
    await this.ready;
    if (!this.currentBook) return toast('Open a notebook first.', 'error');
    if (file.size > MAX_IMPORT_FILE) return toast('Could not import: the file is too large (1.5 GB at most). Import it in smaller parts.', 'error');
    try {
      this.board.finishText();
      toast('Reading the file...');
      const doc = await readNotesFile(file);
      const total = doc.notebooks.reduce((n, b) => n + b.notes.length, 0);
      toast(total > 1 ? `Importing ${total} notes...` : 'Importing...');
      const res = await importDocument(this.store, doc, this.currentBook, this.notebooks);
      [this.notebooks, this.notes] = await Promise.all([this.store.listNotebooks(), this.store.listNotes()]);
      const first = this.notes.find((n) => n.id === res.notes[0]?.id);
      const book = this.notebooks.find((b) => b.id === first?.notebook_id);
      if (book && first) await this.switchNotebook(book, first);
      this.renderNoteList();
      const what = res.notes.length === 1 ? `“${res.notes[0].title}”` : `${res.notes.length} notes`;
      const extra = res.notebooks.length ? ` into ${res.notebooks.length === 1 ? 'a new notebook' : `${res.notebooks.length} new notebooks`}` : '';
      toast(`Imported ${what}${extra}.` + (res.skipped ? ` ${res.skipped} damaged item${res.skipped === 1 ? ' was' : 's were'} left out.` : ''));
    } catch (e) {
      toast('Could not import: ' + (e as Error).message, 'error');
    }
  }

  /** "Download my data": every notebook, note, stroke, picture and setting, as a zip. */
  private async exportData() {
    // Everything in the account in one file: ask for the password (or a code) first, so someone
    // who picks up a signed-in device cannot just take it all.
    const account = this.opts.account;
    if (account && !(await confirmItsYou(account, this.user.email, 'Downloading your data gives a copy of everything in your account.'))) return;
    try {
      this.board.finishText();
      toast('Preparing your data...');
      // Include changes still waiting to be saved (and leave out strokes waiting to be deleted).
      const { blob, missingPictures } = await buildExport(this.store, this.user, this.settings, (noteId, saved) => this.queue.overlay(noteId, saved));
      this.download(blob, `lineboard-data-${new Date().toISOString().slice(0, 10)}.zip`);
      if (missingPictures) toast(missingNote(missingPictures), 'error');
      else toast('Your data is downloading.');
    } catch (e) {
      toast('Could not prepare your data: ' + (e as Error).message, 'error');
    }
  }

  /** Delete the account and everything in it, after a typed confirmation and a fresh sign-in check. */
  private async deleteAccount() {
    const account = this.opts.account;
    if (!account) return;
    const typed = await dialog({
      title: 'Delete your account?',
      message:
        'This permanently deletes your account and everything in it: all notebooks, notes, pictures, settings, encryption keys, passkeys and signed-in devices. It cannot be undone. Download your data first if you want a copy. Type DELETE to confirm.',
      input: '',
      ok: 'Delete account',
      danger: true,
    });
    if (typed === null) return;
    if (typed.trim() !== 'DELETE') return toast('Type DELETE (in capitals) to delete your account.', 'error');
    if (!(await confirmItsYou(account, this.user.email, 'Deleting your account is permanent.'))) return;
    try {
      toast('Deleting your account...');
      await account.deleteAccount(this.user.id);
    } catch (e) {
      toast((e as Error).message, 'error');
      return;
    }
    this.settingsPanel.close();
    await this.opts.onAccountDeleted?.();
  }

  /** Guest / local mode: remove every note, picture and setting kept in this browser. */
  private async deleteLocalData() {
    const ok = await dialog({
      title: 'Delete everything on this device?',
      message: 'All notebooks, notes and pictures saved in this browser are deleted. This cannot be undone. Download your data first if you want a copy.',
      ok: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      if (this.store instanceof LocalStore) await this.store.clearAll();
    } catch (e) {
      toast('Could not delete everything: ' + (e as Error).message, 'error');
      return;
    }
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('lb-')) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
    location.reload();
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
      pendingSaves: () => this.queue.pending,
      noteCount: () => this.notes.length,
      signOut: this.opts.signOut,
      account: this.opts.account,
      signInButton: this.opts.signIn ? () => this.signInButton('settings') : undefined,
      exportData: () => this.exportData(),
      exportAll: () => this.exportAll(),
      importNotes: () => this.pickImport(),
      deleteAccount: this.opts.account ? () => this.deleteAccount() : undefined,
      deleteLocalData: this.store.mode === 'local' ? () => this.deleteLocalData() : undefined,
      profile: () => ({ profile: this.profile, url: this.profileUrl }),
      changeProfile: (change) => this.changeProfile(change),
      archived: () => {
        const books = this.notebooks.filter((b) => b.archived_at);
        const live = new Map(this.notebooks.filter((b) => !b.archived_at).map((b) => [b.id, b.name]));
        return {
          notebooks: books.map((b) => ({ id: b.id, name: b.name, notes: this.notes.filter((n) => n.notebook_id === b.id).length })),
          notes: this.notes.filter((n) => n.archived_at && live.has(n.notebook_id ?? '')).map((n) => ({ id: n.id, title: n.title, notebook: live.get(n.notebook_id!)! })),
        };
      },
      unarchive: (kind, id) => this.unarchive(kind, id),
      deleteArchived: async (kind, id) => {
        if (kind === 'note') {
          const n = this.notes.find((x) => x.id === id);
          if (n) await this.deleteNote(n);
        } else {
          const b = this.notebooks.find((x) => x.id === id);
          if (b) await this.deleteNotebook(b);
        }
      },
    });
  }

  private openSettings() {
    this.settingsPanel.open();
  }
}
