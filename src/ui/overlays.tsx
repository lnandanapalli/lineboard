import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { create } from 'zustand';
import { appRect, appViewport } from '../orientation';
import { Svg } from './Icon';
import { icons } from '../icons';

/**
 * Dialogs, popovers and menus, drawn by React (<Overlays /> in main.tsx). Code anywhere in the app
 * opens them with plain functions (dialog, popover, actionMenu), as before React.
 */

export interface DialogOptions {
  title: string;
  message?: string;
  input?: string;
  /** Show a list to pick from; resolves to the chosen value. */
  choices?: { value: string; label: string }[];
  ok?: string;
  danger?: boolean;
  /** Longest text the field takes. */
  maxLength?: number;
  /** A checkbox under the field; its state is written back to `value` when the dialog is confirmed. */
  check?: { label: string; value: boolean; hint?: string };
}

type Overlay =
  | { id: number; kind: 'dialog'; opts: DialogOptions; resolve: (v: string | null) => void }
  | { id: number; kind: 'popover'; anchor: HTMLElement; label: string; content: ReactNode | HTMLElement; host: HTMLElement; onClose?: () => void }
  | { id: number; kind: 'custom'; render: (close: () => void) => ReactNode };

const useOverlays = create<{ items: Overlay[] }>(() => ({ items: [] }));
let nextId = 1;

const add = (o: Overlay) => flushSync(() => useOverlays.setState((s) => ({ items: [...s.items, o] })));
const remove = (id: number) => useOverlays.setState((s) => ({ items: s.items.filter((o) => o.id !== id) }));

/** Where popups go: inside an open modal dialog if there is one (it is drawn above everything else), else the app. */
const popupHost = () => [...document.querySelectorAll<HTMLElement>('dialog[open]')].pop() ?? document.querySelector<HTMLElement>('.app') ?? document.body;

/** Keep a popup inside the screen below its button; it scrolls when the screen is short (a phone sideways). */
function fitBelow(el: HTMLElement, top: number) {
  el.style.maxHeight = `${Math.max(120, appViewport().height - top - 8)}px`;
  el.style.overflowY = 'auto';
  el.style.overscrollBehavior = 'contain';
}

// Only one popover or menu is open at a time.
let openMenu: { close: () => void } | null = null;

/** Close the open popover or menu, if any. True if one was open (so a second press on its button just closes it). */
export const closeOpenMenu = () => {
  const had = !!openMenu;
  openMenu?.close();
  return had;
};

/** In-page confirm / prompt dialog. Resolves null on cancel. */
export function dialog(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => add({ id: nextId++, kind: 'dialog', opts, resolve }));
}

/**
 * A panel anchored under a button (size slider, shape palette...). Closes on outside press, Escape
 * or resize. `content` is React, or (for screens not yet converted) an element.
 */
export function popover(anchor: HTMLElement, content: ReactNode | HTMLElement, opts: { label: string; onClose?: () => void }) {
  openMenu?.close();
  const id = nextId++;
  const close = () => {
    if (!useOverlays.getState().items.some((o) => o.id === id)) return;
    remove(id);
    anchor.setAttribute('aria-expanded', 'false');
    if (openMenu?.close === close) openMenu = null;
    opts.onClose?.();
  };
  openMenu = { close };
  add({ id, kind: 'popover', anchor, label: opts.label, content, host: popupHost(), onClose: close });
  anchor.setAttribute('aria-expanded', 'true');
  return { close };
}

/** Show something of its own (search) until it closes itself. */
export function showOverlay(render: (close: () => void) => ReactNode) {
  const id = nextId++;
  const close = () => remove(id);
  add({ id, kind: 'custom', render });
  return { close };
}

export interface ActionItem {
  label: string;
  icon?: string;
  danger?: boolean;
  run: () => void;
}

/** A small menu of actions under a button (a note's or notebook's "⋯"). */
export function actionMenu(anchor: HTMLElement, label: string, items: ActionItem[]) {
  if (anchor.getAttribute('aria-expanded') === 'true') {
    closeOpenMenu();
    return;
  }
  const { close } = popover(anchor, <ActionList label={label} items={items} close={() => close()} />, { label });
}

function ActionList({ label, items, close }: { label: string; items: ActionItem[]; close: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      className="action-menu"
      role="menu"
      aria-label={label}
      ref={list}
      onKeyDown={(e) => {
        const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('.action-item') ?? [])];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
        }
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          className={'action-item' + (it.danger ? ' danger' : '')}
          type="button"
          role="menuitem"
          onClick={() => {
            close();
            it.run();
          }}
        >
          {it.icon && <Svg icon={it.icon} />}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Every open dialog, popover and menu. */
export function Overlays() {
  const items = useOverlays((s) => s.items);
  return (
    <>
      {items.map((o) =>
        o.kind === 'dialog' ? (
          <Dialog key={o.id} opts={o.opts} done={(v) => (remove(o.id), o.resolve(v))} />
        ) : o.kind === 'popover' ? (
          <Popover key={o.id} item={o} />
        ) : (
          <Custom key={o.id} render={o.render} close={() => remove(o.id)} />
        ),
      )}
    </>
  );
}

function Custom({ render, close }: { render: (close: () => void) => ReactNode; close: () => void }) {
  return <>{render(close)}</>;
}

function Dialog({ opts, done }: { opts: DialogOptions; done: (v: string | null) => void }) {
  const d = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(opts.input ?? '');
  const [choice, setChoice] = useState(opts.choices?.[0]?.value ?? '');
  const [checked, setChecked] = useState(opts.check?.value ?? false);
  useLayoutEffect(() => {
    d.current?.showModal();
    if (field.current) {
      field.current.focus();
      field.current.select();
    }
  }, []);
  return createPortal(
    <dialog
      className="modal small"
      ref={d}
      onCancel={(e) => {
        e.preventDefault();
        done(null);
      }}
    >
      <form
        method="dialog"
        className="dlg"
        onSubmit={(e) => {
          e.preventDefault();
          if (opts.check) opts.check.value = checked;
          done(opts.input !== undefined ? text : opts.choices ? choice : 'ok');
        }}
      >
        <h3>{opts.title}</h3>
        {opts.message && <p>{opts.message}</p>}
        {opts.input !== undefined && <input ref={field} type="text" className="dlg-input" value={text} maxLength={opts.maxLength} onChange={(e) => setText(e.target.value)} />}
        {opts.choices && (
          <select className="dlg-input" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {opts.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {opts.check && (
          <label className="dlg-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>
              {opts.check.label}
              {opts.check.hint && <small>{opts.check.hint}</small>}
            </span>
          </label>
        )}
        <div className="dlg-actions">
          <button className="btn" type="button" onClick={() => done(null)}>
            Cancel
          </button>
          <button className={'btn ' + (opts.danger ? 'danger' : 'primary')} type="submit">
            {opts.ok ?? 'OK'}
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

/** Mounts an element made outside React (popover content from a screen not yet converted). */
function Element({ el }: { el: HTMLElement }) {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    slot.current?.append(el);
    return () => el.remove();
  }, [el]);
  return <span ref={slot} style={{ display: 'contents' }} />;
}

function Popover({ item }: { item: Extract<Overlay, { kind: 'popover' }> }) {
  const panel = useRef<HTMLDivElement>(null);
  const { anchor, host, onClose } = item;
  useLayoutEffect(() => {
    const p = panel.current;
    if (!p) return;
    // Where to measure from. Normally the screen (in the app's own coordinates, which follow its
    // rotation). A host that is itself turned (a dialog with the app rotated) is the frame its
    // fixed-position children are placed in, so the popup is placed within it instead.
    const turned = host.tagName === 'DIALOG' && getComputedStyle(host).rotate !== 'none' && getComputedStyle(host).rotate !== '';
    const frame = turned ? appRect(host) : { left: 0, top: 0, ...appViewport() };
    const a = appRect(anchor);
    const r = { left: a.left - frame.left, top: a.top - frame.top, bottom: a.bottom - frame.top, width: a.width };
    p.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - p.offsetWidth / 2, frame.width - p.offsetWidth - 8))}px`;
    // Below the button, or above it when it sits low (the sidebar's account chip, the end of a dialog).
    if (r.bottom + 6 + p.offsetHeight > frame.height - 8 && r.top - 6 - p.offsetHeight >= 8) {
      p.style.top = `${r.top - 6 - p.offsetHeight}px`;
    } else {
      p.style.top = `${r.bottom + 6}px`;
      if (!turned) fitBelow(p, r.bottom + 6);
    }
    p.querySelector<HTMLElement>('input, button')?.focus();
  }, [anchor, host]);
  useEffect(() => {
    const onOutside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
        anchor.focus();
      }
    };
    const onResize = () => onClose?.();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div className="popover" role="dialog" aria-label={item.label} ref={panel}>
      {item.content instanceof HTMLElement ? <Element el={item.content} /> : item.content}
    </div>,
    host,
  );
}

// ----------------------------- dropdown -----------------------------

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  /** Shortcut hint shown on the right, e.g. "M". */
  hint?: string;
}

/**
 * A toolbar dropdown: a button showing the current choice, opening a menu of options.
 * Keyboard: Enter/Space/ArrowDown open it, arrows move, Enter picks, Escape closes.
 * With `split`, pressing the icon calls onMain with the current choice; only the arrow opens the menu.
 */
export function Dropdown<T extends string>(props: {
  name: string;
  options: MenuOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  /** Hide the text label on narrow toolbars (CSS decides); the icon always shows. */
  className?: string;
  /** Call onSelect even when the current option is picked again (e.g. to switch to that tool). */
  reselect?: boolean;
  split?: { onMain: (value: T) => void; title?: (label: string) => string; className?: string; active?: boolean };
}) {
  const { name, options, value, onSelect, split } = props;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const o = options.find((x) => x.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    openMenu?.close();
    const mine = { close };
    openMenu = mine;
    const onOutside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !wrap.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      // Keys the menu handles must not also reach the board's shortcuts (arrows step strips).
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        btn.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      } else if (e.key === 'Tab') close();
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      if (openMenu === mine) openMenu = null;
    };
  }, [open]);

  // Place the menu under its button, within the screen, and focus the chosen option.
  useLayoutEffect(() => {
    const m = menu.current;
    if (!open || !m || !wrap.current) return;
    const r = appRect(wrap.current);
    m.style.top = `${r.bottom + 6}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, appViewport().width - m.offsetWidth - 8))}px`;
    fitBelow(m, r.bottom + 6);
    (m.querySelector<HTMLElement>('[aria-checked=true]') ?? m.querySelector<HTMLElement>('button'))?.focus();
  }, [open]);

  const arrow = (
    <button
      ref={btn}
      className={(split ? 'split-arrow ' : 'dropdown-btn ') + (props.className ?? '')}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={split ? `${name} options` : `${name}: ${o.label}`}
      title={split ? `${name} options` : `${name}: ${o.label}`}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' && !open) {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {split ? (
        <Svg icon={icons.chevron} />
      ) : (
        <>
          {o.icon && <Svg icon={o.icon} />}
          <span className="dropdown-label">{o.label}</span>
          <Svg icon={icons.chevron} />
        </>
      )}
    </button>
  );

  const list = open
    ? createPortal(
        <div className="dropdown-menu" role="menu" aria-label={name} ref={menu}>
          {options.map((x) => (
            <button
              key={x.value}
              className="dropdown-item"
              type="button"
              role="menuitemradio"
              aria-checked={x.value === value}
              onClick={() => {
                setOpen(false);
                if (x.value !== value || props.reselect) onSelect(x.value);
              }}
            >
              {x.icon && <Svg icon={x.icon} />}
              <span className="dropdown-text">
                <b>{x.label}</b>
                <small>{x.description ?? ''}</small>
              </span>
              <kbd hidden={!x.hint}>{x.hint ?? ''}</kbd>
            </button>
          ))}
        </div>,
        popupHost(),
      )
    : null;

  if (!split) {
    return (
      <>
        <span ref={(el) => void (wrap.current = el)} style={{ display: 'contents' }}>
          {arrow}
        </span>
        {list}
      </>
    );
  }
  const title = split.title?.(`${name}: ${o.label}`) ?? `${name}: ${o.label}`;
  return (
    <div ref={(el) => void (wrap.current = el)} className={'split-btn ' + (split.className ?? '') + (split.active ? ' active' : '')} role="group" aria-label={name}>
      <button className="split-main" type="button" aria-label={`${name}: ${o.label}`} title={title} onClick={() => split.onMain(value)}>
        {o.icon && <Svg icon={o.icon} />}
      </button>
      {arrow}
      {list}
    </div>
  );
}


/** An ⓘ button that explains something in a small popup. Safe inside a <label>. */
export function InfoButton({ topic, text }: { topic: string; text: string }) {
  return (
    <button
      className="info-btn"
      type="button"
      aria-label={`About ${topic}`}
      title={`About ${topic}`}
      aria-haspopup="dialog"
      aria-expanded="false"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const b = e.currentTarget;
        if (b.getAttribute('aria-expanded') === 'true') return void closeOpenMenu();
        popover(b, <p className="info-text">{text}</p>, { label: topic });
      }}
      dangerouslySetInnerHTML={{ __html: icons.info }}
    />
  );
}
