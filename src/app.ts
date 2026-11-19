import { Board, PAGE_W, TEXT_FONT } from './board';
import { SettingsPanel } from './settings';
import type { AccountSecurity } from './account';
import { icons } from './icons';
import { logo } from './brand';
import type { Store } from './store/store';
import { SyncQueue, type SyncState } from './sync';
import { SHAPE_ICONS, SHAPE_NAMES, SHAPES } from './shapes';
import { IMAGE_TYPES, prepareImage } from './images';
import { withDefaults, type AppUser, type BoardMode, type Notebook, type NoteMeta, type Settings, type Stroke, type Tool } from './types';
import { closeOpenMenu, dropdown, popover, type Dropdown } from './menu';
import { isApple, withShortcut } from './keys';
import { attachOrientation, detachOrientation, orientation } from './orientation';
import { debounce, dialog, h, lsGet, lsSet, toast, uuid } from './util';

const PEN_COLORS = ['#111827', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'];
/** Size ranges (page units; the page is 1000 wide) and quick presets for each tool. */
const SIZES = {
  pen: { min: 1, max: 24, step: 0.5, presets: [2, 3.5, 6] },
  highlighter: { min: 6, max: 60, step: 1, presets: [14, 22, 32] },
  text: { min: 10, max: 100, step: 1, presets: [20, 28, 44] },
};

type Action = { type: 'add' | 'remove'; strokes: Stroke[] } | { type: 'replace'; from: Stroke[]; to: Stroke[] };

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
  private sizeBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private modeMenu!: Dropdown<BoardMode>;
  private shapeBtn!: HTMLButtonElement;
  private selectMenu!: Dropdown<'lasso' | 'rect'>;
  /** The last strip mode, so F (free on/off) returns to it. */
  private lastStripMode: BoardMode = 'strips';
  private stripControls!: HTMLElement;
  private status!: HTMLElement;
  private rotateBtn!: HTMLButtonElement;
  private appEl!: HTMLElement;
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
    this.settings = withDefaults(lsGet<Partial<Settings>>(this.lsKey('settings'), {}));
    this.queue = new SyncQueue(store, this.lsKey('queue'));
    this.queue.onState = (s) => this.renderStatus(s);
    this.build();
    this.renderStatus(this.queue.pending ? 'saving' : 'saved');
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
    this.queue.stop();
    detachOrientation(this.appEl);
    this.settingsPanel.destroy();
  }

  private lsKey(k: string) {
    return `lb-${k}-${this.user.id}`;
  }

  private async init() {
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
      className: 'tool-dropdown select-btn',
      value: this.settings.selectMode,
      reselect: true,
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
    // Shapes: a palette of shapes, opened from one button.
    this.shapeBtn = h('button', { class: 'dropdown-btn tool-dropdown shape-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    this.shapeBtn.addEventListener('click', () => this.openShapePalette());
    tools.append(this.shapeBtn);
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

    const toolbar = h(
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

    this.appEl = h('div', { class: 'app' }, toolbar, main);
    this.root.replaceChildren(this.appEl);
    attachOrientation(this.appEl);
    const showRotate = () => (this.rotateBtn.hidden = !orientation.manual);
    showRotate();
    const off = orientation.onChange(showRotate);
    this.abort.signal.addEventListener('abort', () => off());

    this.board = new Board(boardHost, this.settings, {
      onStrokesAdded: (s) => this.record({ type: 'add', strokes: s }),
      onStrokesRemoved: (s) => this.record({ type: 'remove', strokes: s }),
      onStrokesReplaced: (from, to) => this.record({ type: 'replace', from, to }),
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
      void this.insertImages(files);
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return; // already handled (an open menu, a text box...)
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
    this.shapeBtn.classList.toggle('active', this.tool === 'shape');
    this.shapeBtn.innerHTML = `${SHAPE_ICONS[this.settings.shape]}${icons.chevron}`;
    this.shapeBtn.setAttribute('aria-label', `Shapes: ${SHAPE_NAMES[this.settings.shape]}`);
    this.shapeBtn.title = withShortcut(`Shapes: ${SHAPE_NAMES[this.settings.shape]}`, 'S');
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
      const b = h('button', { class: 'swatch' + (c.toLowerCase() === cur.toLowerCase() ? ' active' : ''), type: 'button', 'aria-label': 'Color ' + c, title: c });
      b.style.setProperty('--c', c);
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

  /** The size of the pen or highlighter (whichever is in use). */
  private get sizeTool(): 'pen' | 'highlighter' | 'text' {
    return this.tool === 'highlighter' || this.tool === 'text' ? this.tool : 'pen';
  }
  private get size() {
    return { pen: this.settings.penWidth, highlighter: this.settings.highlighterWidth, text: this.settings.textSize }[this.sizeTool];
  }
  private set size(w: number) {
    if (this.sizeTool === 'highlighter') this.settings.highlighterWidth = w;
    else if (this.sizeTool === 'text') this.settings.textSize = w;
    else this.settings.penWidth = w;
  }
  private get sizeName() {
    return { pen: 'Pen', highlighter: 'Highlighter', text: 'Text' }[this.sizeTool];
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
        const b = h('button', { class: 'btn' + (w === this.size ? ' active' : ''), type: 'button', 'data-w': String(w) }, ['Thin', 'Medium', 'Thick'][i]);
        b.addEventListener('click', () => set(w));
        return b;
      }),
    );
    draw();
    popover(this.sizeBtn, h('div', { class: 'size-picker' }, preview, h('div', { class: 'range' }, slider, value), presets), { label: `${this.sizeName} size` });
  }

  /** Add pictures to the page: save each, then place it in view and select it (to move or resize). */
  private async insertImages(files: File[]) {
    const pics = files.filter((f) => f.type.startsWith('image/'));
    if (!pics.length) return;
    await this.ready; // a picture pasted right after the page opened waits for the note
    if (!this.current) return toast('Open a note first.', 'error');
    let last: Stroke | null = null;
    for (const file of pics) {
      try {
        const img = await prepareImage(file);
        const id = uuid();
        await this.store.putImage(id, img.blob);
        const bitmap = await createImageBitmap(img.blob);
        last = this.board.insertImage(id, img.type, bitmap);
      } catch (e) {
        toast('Could not add the picture: ' + (e as Error).message, 'error');
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
    ({ close } = popover(this.shapeBtn, h('div', { class: 'shape-palette' }, grid, foot), { label: 'Shapes' }));
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
