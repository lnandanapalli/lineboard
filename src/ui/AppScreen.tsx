import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { SettingsDialog } from './Settings';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import type { App, AppView } from '../app';
import { isLight } from '../app';
import { icons } from '../icons';
import { isApple, withShortcut } from '../keys';
import { HL_COLORS, PEN_COLORS } from '../colors';
import { SHAPE_ICONS, SHAPE_NAMES } from '../shapes';
import { IMAGE_TYPES } from '../images';
import { MAX_NOTE_TITLE } from '../limits';
import { orientation, appRect, appViewport, clientToApp } from '../orientation';
import { attachNameTips } from '../nameTip';
import { Avatar } from './Avatar';
import { lsGet, lsSet } from '../util';
import type { Notebook, NoteMeta } from '../types';
import { Logo } from './Logo';
import { Mount } from './Mount';
import { HistoryView } from './History';
import { Svg } from './Icon';
import { Dropdown } from './overlays';
import type { BoardMode } from '../types';

/** Re-render when one slice of the app's view changes (see AppView in app.ts). */
const useView = <K extends keyof AppView>(app: App, key: K) => useStore(app.view, (v) => v[key]);


/** A toolbar-style button showing one of the app's icons. `label` defaults to the title. */
function IconButton({ icon, title, label, className = '', ...rest }: { icon: string; title: string; label?: string; className?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...rest} className={'icon-btn ' + className} type="button" title={title} aria-label={label ?? title} dangerouslySetInnerHTML={{ __html: icon }} />;
}

/** The notes app: toolbar, sidebar and the board. The logic lives in App (app.ts). */
export function AppScreen({ app }: { app: App }) {
  const appEl = useRef<HTMLDivElement>(null);
  const sidebarOpen = useView(app, 'sidebarOpen');
  const historyOpen = useView(app, 'historyOpen');
  const historyPanel = useView(app, 'historyPanel');
  // orientation.ts turns the element and adds `rotated`; the class is kept here too, or React would
  // drop it whenever it rewrites the class list (the sidebar or history opening).
  const rotated = useSyncExternalStore(orientation.onChange, () => orientation.applied !== 0);
  useLayoutEffect(() => {
    if (appEl.current) app.attach(appEl.current);
  }, [app]);
  return (
    <div ref={appEl} className={'app' + (sidebarOpen ? ' sidebar-open' : '') + (historyOpen ? ' history-open' : '') + (rotated ? ' rotated' : '')}>
      <Toolbar app={app} inert={historyOpen} />
      <div className="main">
        <Sidebar app={app} inert={historyOpen} />
        <div className="scrim" onClick={() => app.toggleSidebar(false)} />
        <Mount el={app.boardHost} />
        <FirstHint app={app} />
        {historyPanel && <HistoryView panel={historyPanel} />}
      </div>
      <SettingsDialog panel={app.settingsPanel} />
    </div>
  );
}

/** How the strips work, on the board until dismissed (once per device). */
function FirstHint({ app }: { app: App }) {
  const [shown, setShown] = useState(() => !lsGet('lb-hint-dismissed', false));
  const [how] = useState(() => app.hintText());
  if (!shown) return null;
  return createPortal(
    <div className="hint">
      <b>How it works:</b> {how}{' '}
      <button
        type="button"
        className="link"
        onClick={() => {
          setShown(false);
          lsSet('lb-hint-dismissed', true);
        }}
      >
        Got it
      </button>
    </div>,
    app.boardHost,
  );
}

// ----------------------------- toolbar -----------------------------

function Toolbar({ app, inert }: { app: App; inert: boolean }) {
  const historyPanel = useView(app, 'historyPanel');
  const rotateShown = useView(app, 'rotateShown');
  return (
    <header className="toolbar" inert={inert}>
      <IconButton icon={icons.menu} title="Notes" onClick={() => app.toggleSidebar()} />
      <TitleInput app={app} />
      <div className="sep" />
      <Tools app={app} />
      <Swatches app={app} />
      <SizeButton app={app} />
      <div className="sep" />
      <UndoGroup app={app} />
      <div className="sep" />
      <ModeMenu app={app} />
      <StripControls app={app} />
      <div className="spacer" />
      {app.opts.signIn && <SignInButton app={app} where="toolbar" />}
      <Status app={app} />
      <IconButton icon={icons.rotate} title="Rotate right" className="rotate-btn" hidden={!rotateShown} onClick={() => orientation.rotateRight()} />
      <IconButton icon={icons.history} title="Version history" className={historyPanel ? 'active' : ''} onClick={() => void app.openHistory()} />
      <IconButton icon={icons.download} title="Share or export" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => app.openExportMenu(e.currentTarget)} />
      <IconButton icon={icons.gear} title="Settings" onClick={() => app.openSettings()} />
    </header>
  );
}

/** Mode: how the page takes ink. */
function ModeMenu({ app }: { app: App }) {
  useView(app, 'mode');
  return (
    <Dropdown<BoardMode>
      name="Mode"
      className="mode-btn"
      value={app.mode}
      onSelect={(m) => app.setMode(m)}
      options={[
        { value: 'strips', label: 'Strips', icon: icons.strip, hint: 'M', description: 'Unlock one strip to write; rest your palm anywhere else.' },
        { value: 'multi', label: 'Multi-strip', icon: icons.multi, hint: 'M', description: 'Unlock several strips at once for bigger drawings.' },
        { value: 'split', label: 'Split', icon: icons.split, description: 'Two panes, each locked or unlocked; the page scrolls under them. Tap the divider grip, then drag, to resize.' },
        { value: 'free', label: 'Free whiteboard', icon: icons.free, hint: 'F', description: 'The whole page takes ink. Two fingers scroll and zoom.' },
      ]}
    />
  );
}

/** Select: a free-hand loop or a dragged rectangle. The icon picks the tool; the arrow chooses which. */
function SelectMenu({ app }: { app: App }) {
  useView(app, 'tools');
  return (
    <Dropdown<'lasso' | 'rect'>
      name="Select"
      className="select-btn"
      value={app.selectMode}
      reselect
      split={{ className: 'select-tool', onMain: () => app.setTool('select'), title: (t) => withShortcut(t, 'V'), active: app.toolState().tool === 'select' }}
      onSelect={(m) => app.setSelectMode(m)}
      options={[
        { value: 'lasso', label: 'Lasso select', icon: icons.lasso, hint: 'V', description: 'Draw a loop around what you want.' },
        { value: 'rect', label: 'Rectangle select', icon: icons.rectSelect, hint: 'V', description: 'Drag a box around what you want.' },
      ]}
    />
  );
}

/** The note's title: what is typed stays until the field is left (Enter or a tap elsewhere), then it is saved. */
function TitleInput({ app }: { app: App }) {
  const title = useView(app, 'title');
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== title) void app.renameCurrent(draft);
    setDraft(null);
  };
  return (
    <input
      className="title-input"
      type="text"
      aria-label="Note title"
      maxLength={MAX_NOTE_TITLE}
      value={draft ?? title}
      onFocus={() => setDraft(title)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

const TOOLS = [
  ['pen', icons.pen, 'Pen', 'P'],
  ['highlighter', icons.highlighter, 'Highlighter', 'H'],
  ['eraser', icons.eraser, 'Eraser', 'E'],
  ['text', icons.text, 'Text', 'T'],
] as const;

function Tools({ app }: { app: App }) {
  useView(app, 'tools');
  const { tool, shape } = app.toolState();
  const filePick = useRef<HTMLInputElement>(null);
  const shapeName = `Shapes: ${SHAPE_NAMES[shape]}`;
  return (
    <div className="group">
      {TOOLS.map(([t, icon, label, key]) => (
        <IconButton key={t} icon={icon} title={withShortcut(label, key)} label={label} className={'tool' + (tool === t ? ' active' : '')} onClick={() => app.setTool(t)} />
      ))}
      <SelectMenu app={app} />
      {/* Shapes: the icon draws the last shape picked; the arrow opens the palette. */}
      <div className={'split-btn shape-tool' + (tool === 'shape' ? ' active' : '')} role="group" aria-label="Shapes">
        <button className="split-main" type="button" aria-label={shapeName} title={withShortcut(shapeName, 'S')} onClick={() => app.setTool('shape')} dangerouslySetInnerHTML={{ __html: SHAPE_ICONS[shape] }} />
        <button
          className="split-arrow shape-btn"
          type="button"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-label="Shape options"
          title="Shape options"
          onClick={(e) => app.openShapePalette(e.currentTarget)}
          dangerouslySetInnerHTML={{ __html: icons.chevron }}
        />
      </div>
      {/* Insert a picture (also: paste, or drop a file on the page). */}
      <IconButton icon={icons.image} title="Insert picture" onClick={() => filePick.current?.click()} />
      <input
        ref={filePick}
        type="file"
        accept={IMAGE_TYPES}
        multiple
        hidden
        aria-hidden="true"
        onChange={(e) => {
          void app.insertImages([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}

/**
 * The colours for the tool in use. Every tool gets the same number of colour slots (the longest
 * palette plus a custom one), so the toolbar never shifts when the tool changes.
 */
function Swatches({ app }: { app: App }) {
  useView(app, 'tools');
  const { colors, color, shown, off } = app.toolState();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // A colour chosen with the picker shows as its own swatch after the palette.
  const list = colors.some((c) => same(c, color)) ? [...colors] : [...colors, color];
  const slots = Math.max(PEN_COLORS.length, HL_COLORS.length) + 1;
  return (
    <div className={'group swatches' + (off ? ' disabled' : '')} aria-disabled={off}>
      {list.map((c) => {
        const on = same(c, color);
        const look = shown(c);
        // The chosen colour: a ring around it and a check inside, light or dark to stand out on it.
        const style = { '--c': look, ...(on ? { '--tick': isLight(look) ? '#111827' : '#ffffff' } : {}) } as CSSProperties;
        return (
          <button
            key={c}
            className={'swatch' + (on ? ' active' : '')}
            type="button"
            aria-label={'Color ' + c}
            aria-pressed={on}
            title={c}
            disabled={off}
            style={style}
            onClick={() => app.pickColor(c)}
            dangerouslySetInnerHTML={on ? { __html: icons.check } : undefined}
          />
        );
      })}
      {Array.from({ length: slots - list.length }, (_, i) => (
        <span key={'slot' + i} className="swatch-slot" aria-hidden="true" />
      ))}
      <label className="swatch-more" title="Custom colour">
        <input
          type="color"
          className="color-input"
          aria-label="Custom colour"
          tabIndex={-1}
          disabled={off}
          value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000'}
          onChange={(e) => app.pickColor(e.target.value)}
        />
        <Svg icon={icons.plus} />
      </label>
    </div>
  );
}

/** A dot drawn at the current size (capped so it fits), in the ink's on-screen colour. */
function SizeButton({ app }: { app: App }) {
  useView(app, 'tools');
  const { size, sizeName, dotPx, dotColor, off } = app.toolState();
  const label = `${sizeName} size: ${size}`;
  return (
    <button className="size-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label={label} title={label} disabled={off} onClick={(e) => app.openSizePicker(e.currentTarget)}>
      <i className="size-dot" style={{ width: `${dotPx}px`, height: `${dotPx}px`, background: dotColor }} />
    </button>
  );
}

function UndoGroup({ app }: { app: App }) {
  useView(app, 'undo');
  const { canUndo, canRedo } = app.undoState();
  return (
    <div className="group">
      <IconButton icon={icons.undo} title={withShortcut('Undo', 'Mod+Z')} disabled={!canUndo} onClick={() => app.undo()} />
      <IconButton icon={icons.redo} title={withShortcut('Redo', isApple ? 'Mod+Shift+Z' : 'Mod+Y')} disabled={!canRedo} onClick={() => app.redo()} />
      <IconButton icon={icons.clearPage} title="Clear page" className="clear-btn" onClick={() => void app.clearPage()} />
    </div>
  );
}

function StripControls({ app }: { app: App }) {
  useView(app, 'mode');
  const mode = app.mode;
  // Previous / next strip mean nothing when the screen is split into two fixed panes.
  return (
    <div className="group strip-controls" hidden={mode === 'free'}>
      <IconButton icon={icons.up} title={withShortcut('Previous strip', 'Up')} className="step-btn" hidden={mode === 'split'} onClick={() => app.stepLine(-1)} />
      <IconButton icon={icons.down} title={withShortcut('Next strip', 'Down')} className="step-btn" hidden={mode === 'split'} onClick={() => app.stepLine(1)} />
      <IconButton icon={icons.lockAll} title="Lock all strips" onClick={() => app.lockAll()} />
    </div>
  );
}

function Status({ app }: { app: App }) {
  useView(app, 'status');
  const { state, text, retryText } = app.statusState();
  // In guest mode the "Sign in to save" button sits next to it, so show just the coloured dot.
  return (
    <div className={'status ' + state + (app.opts.signIn ? ' compact' : '')} title={text} aria-label={text} data-retry-text={retryText}>
      <div className="status-label"><span>{text}</span></div>
    </div>
  );
}

function SignInButton({ app, where }: { app: App; where: 'toolbar' | 'sidebar' }) {
  return (
    <button className={'btn primary signin-save signin-' + where} type="button" title="Sign in or create an account to save your notes" onClick={() => void app.goSignIn()}>
      <Svg icon={icons.cloud} />
      <span>Sign in to save</span>
    </button>
  );
}

// ----------------------------- sidebar -----------------------------

function Sidebar({ app, inert }: { app: App; inert: boolean }) {
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    if (el.current) attachNameTips(el.current, '.note-title, .book-title, .book-name');
  }, []);
  const local = app.store.mode === 'local';
  return (
    <aside className="sidebar" ref={el} inert={inert}>
      <div className="sidebar-head">
        <div className="brand">
          <Logo />
          <span>Lineboard</span>
        </div>
        <IconButton icon={icons.close} title="Close" onClick={() => app.toggleSidebar(false)} />
      </div>
      <button className="search-btn" type="button" title={withShortcut('Search notes and notebooks', 'Mod+K')} onClick={() => app.openSearch()}>
        <Svg icon={icons.search} />
        <span>Search</span>
        <kbd>{isApple ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div className="section-label">Notebook</div>
      <Notebooks app={app} />
      <div className="note-buttons">
        <button className="btn primary" type="button" onClick={() => void app.newNote(true)}>
          <Svg icon={icons.plus} />
          <span>New note</span>
        </button>
        <button className="btn import-btn" type="button" title="Import notes from a Lineboard file (.lbd) or a zip of them" onClick={() => app.pickImport()}>
          <Svg icon={icons.upload} />
          <span>Import</span>
        </button>
      </div>
      <NoteList app={app} />
      <div className="sidebar-foot">
        <TrashButton app={app} />
        {/* Name and picture, not the email: the sidebar is on screen in recordings and screen shares. */}
        <AccountChip app={app} />
        <small className="foot-note">
          {app.opts.signIn ? 'Trying without an account: notes are saved in this browser only.' : local ? 'Local mode: notes stay on this device.' : 'Synced to your account.'}
        </small>
      </div>
      {app.opts.signIn && <SignInButton app={app} where="sidebar" />}
      <ResizeHandle sidebar={el} />
    </aside>
  );
}

function StarButton({ app, kind, item }: { app: App; kind: 'note' | 'notebook'; item: NoteMeta | Notebook }) {
  const name = 'title' in item ? item.title || 'Untitled' : item.name;
  return (
    <IconButton
      icon={item.starred ? icons.starFilled : icons.star}
      title={item.starred ? `Unstar "${name}"` : `Star "${name}"`}
      className={'small star-btn' + (item.starred ? ' on' : '')}
      aria-pressed={!!item.starred}
      onClick={() => app.toggleStar(kind, item)}
    />
  );
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function NoteList({ app }: { app: App }) {
  useView(app, 'notes');
  const { starred, notes, currentId, currentBookId, bookNames } = app.listState();
  const row = (n: NoteMeta, starredList: boolean) => {
    // In "Starred", a note from another notebook says which one it is in.
    const sub = starredList && n.notebook_id !== currentBookId ? (bookNames.get(n.notebook_id ?? '') ?? '') : dateFmt.format(new Date(n.updated_at));
    const title = n.title || 'Untitled';
    return (
      <li key={(starredList ? 's:' : '') + n.id} className={n.id === currentId ? 'active' : ''}>
        <button
          className="note-open"
          type="button"
          onClick={() => {
            void app.openFromList(n);
            if (window.innerWidth < 900) app.toggleSidebar(false);
          }}
        >
          <span className="note-title">{title}</span>
          <span className="note-date">{sub}</span>
        </button>
        <div className="note-actions">
          <StarButton app={app} kind="note" item={n} />
          <IconButton icon={icons.more} title={`More for "${title}"`} className="small more-btn" aria-haspopup="menu" aria-expanded="false" onClick={(e) => app.noteMenu(n, e.currentTarget)} />
        </div>
      </li>
    );
  };
  return (
    <ul className="note-list">
      {starred.length > 0 && (
        <>
          <li className="list-label" role="presentation">
            Starred
          </li>
          {starred.map((n) => row(n, true))}
          <li className="list-label" role="presentation">
            Notes
          </li>
        </>
      )}
      {notes.map((n) => row(n, false))}
    </ul>
  );
}

/** The open notebook's button, and the panel listing every notebook (with note counts). */
function Notebooks({ app }: { app: App }) {
  useView(app, 'notes');
  const open = useView(app, 'bookPanelOpen');
  const { current, items } = app.booksState();
  return (
    <>
      <button className={'book-button' + (open ? ' open' : '')} type="button" aria-expanded={open} title="Switch notebook" onClick={() => app.toggleBookPanel()}>
        <Svg icon={icons.notebook} />
        <span className="book-name">{current?.name ?? ''}</span>
        <Svg icon={icons.chevron} />
      </button>
      <div className="book-panel" hidden={!open}>
        <ul className="book-list">
          {items.map(({ nb, count }) => (
            <li key={nb.id} className={nb.id === current?.id ? 'active' : ''}>
              <button
                className="book-open"
                type="button"
                onClick={() => {
                  app.toggleBookPanel(false);
                  if (nb.id !== current?.id) void app.switchNotebook(nb);
                }}
              >
                <span className="book-title">{nb.name}</span>
                <span className="book-count">{count}</span>
              </button>
              <div className="note-actions">
                <StarButton app={app} kind="notebook" item={nb} />
                <IconButton icon={icons.more} title={`More for "${nb.name}"`} className="small more-btn" aria-haspopup="menu" aria-expanded="false" onClick={(e) => app.notebookMenu(nb, e.currentTarget)} />
              </div>
            </li>
          ))}
        </ul>
        <button className="btn book-new" type="button" onClick={() => void app.newNotebook()}>
          <Svg icon={icons.plus} />
          <span>New notebook</span>
        </button>
      </div>
    </>
  );
}

/** At the bottom of the sidebar: opens the trash (Settings > Data controls). */
function TrashButton({ app }: { app: App }) {
  useView(app, 'notes');
  const { shown, count } = app.trashState();
  return (
    <button className="trash-btn" type="button" hidden={!shown} aria-label={count ? `Trash, ${count} item${count === 1 ? '' : 's'}` : 'Trash, empty'} onClick={() => app.settingsPanel.openTrash()}>
      <Svg icon={icons.trash} />
      <span>Trash</span>
      <span className="trash-count">{count ? String(count) : ''}</span>
    </button>
  );
}

/** Your name and picture; opens Settings (profile, data controls and sign-out are all there). */
function AccountChip({ app }: { app: App }) {
  useView(app, 'profile');
  const { profile, url } = app.profileState();
  const name = profile.name;
  return (
    <button className="account-chip" type="button" aria-label={`${name || 'Your profile'}: settings`} title="Settings" onClick={() => app.settingsPanel.open('account')}>
      <Avatar profile={profile} url={url} size={32} />
      <span className={'account-name' + (name ? '' : ' empty')}>{name || 'Add your name'}</span>
      <Svg icon={icons.gear} />
    </button>
  );
}

/**
 * The sidebar's right edge can be dragged to make it wider or narrower, within limits so it never
 * covers most of the page: 240 px to 560 px, and at most 60% of the screen. Double-click (or
 * Home) puts it back; arrow keys move it in steps. Remembered on this device.
 */
function ResizeHandle({ sidebar }: { sidebar: React.RefObject<HTMLElement | null> }) {
  const handle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const side = sidebar.current;
    const h = handle.current;
    if (!side || !h) return;
    const MIN = 240;
    const max = () => Math.max(MIN, Math.min(560, Math.floor(appViewport().width * 0.6)));
    const apply = (w: number | null) => {
      if (w === null) {
        side.style.removeProperty('--sidebar-w');
        h.removeAttribute('aria-valuenow');
        return;
      }
      const v = Math.round(Math.min(max(), Math.max(MIN, w)));
      side.style.setProperty('--sidebar-w', `${v}px`);
      h.setAttribute('aria-valuenow', String(v));
      h.setAttribute('aria-valuemin', String(MIN));
      h.setAttribute('aria-valuemax', String(max()));
    };
    const save = () => lsSet('lb-sidebar-width', side.style.getPropertyValue('--sidebar-w') ? parseInt(side.style.getPropertyValue('--sidebar-w')) : null);
    const saved = lsGet<number | null>('lb-sidebar-width', null);
    if (typeof saved === 'number' && Number.isFinite(saved)) apply(saved);
    let drag: { id: number; x0: number; w0: number } | null = null;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      // In the app's own coordinates: with the app turned 90°, the on-screen width is its height.
      drag = { id: e.pointerId, x0: clientToApp(e.clientX, e.clientY).x, w0: appRect(side).width };
      side.classList.add('resizing');
    };
    const move = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) apply(drag.w0 + clientToApp(e.clientX, e.clientY).x - drag.x0);
    };
    const end = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      side.classList.remove('resizing');
      save();
    };
    const reset = () => {
      apply(null);
      save();
    };
    const key = (e: KeyboardEvent) => {
      const w = appRect(side).width;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') apply(w + (e.key === 'ArrowRight' ? 24 : -24));
      else if (e.key === 'Home') apply(null);
      else return;
      e.preventDefault();
      save();
    };
    // A smaller window (or turning the device) keeps the sidebar within the limit.
    const resize = () => {
      const cur = parseInt(side.style.getPropertyValue('--sidebar-w'));
      if (cur) apply(cur);
    };
    h.addEventListener('pointerdown', down);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', reset);
    h.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => {
      h.removeEventListener('pointerdown', down);
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', end);
      h.removeEventListener('pointercancel', end);
      h.removeEventListener('dblclick', reset);
      h.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
    };
  }, [sidebar]);
  return <div ref={handle} className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" tabIndex={0} title="Drag to resize (double-click to reset)" />;
}
