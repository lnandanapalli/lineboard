import { icons } from './icons';
import { h } from './util';
import { appRect, appViewport } from './orientation';

/**
 * Menus and popovers go inside the app element, so they turn with it when the app is rotated
 * (a fixed-position child of a transformed element is placed in that element's coordinates).
 */
/** Keep a popup inside the screen below its button; it scrolls when the screen is short (a phone sideways). */
function fitBelow(el: HTMLElement, top: number) {
  el.style.maxHeight = `${Math.max(120, appViewport().height - top - 8)}px`;
  el.style.overflowY = 'auto';
  el.style.overscrollBehavior = 'contain';
}

const popupHost = () => document.querySelector<HTMLElement>('.app') ?? document.body;

/**
 * A toolbar dropdown: a button showing the current choice, opening a menu of options.
 * Keyboard: Enter/Space/ArrowDown open it, arrows move, Enter picks, Escape closes.
 */
export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  /** Shortcut hint shown on the right, e.g. "M". */
  hint?: string;
}

export interface Dropdown<T extends string> {
  /** What goes in the toolbar: the button, or for a split button the wrapper holding both parts. */
  el: HTMLElement;
  set(value: T): void;
  close(): void;
}

let openMenu: { close: () => void } | null = null;

export function dropdown<T extends string>(opts: {
  name: string;
  options: MenuOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  /** Hide the text label on narrow toolbars (CSS decides); the icon always shows. */
  className?: string;
  /** Call onSelect even when the current option is picked again (e.g. to switch to that tool). */
  reselect?: boolean;
  /**
   * A split button: pressing the icon calls onMain with the current choice (e.g. picks the tool),
   * only the arrow next to it opens the menu.
   */
  split?: { onMain: (value: T) => void; title?: (label: string) => string; className?: string };
}): Dropdown<T> {
  let value = opts.value;
  const btn = h('button', {
    class: (opts.split ? 'split-arrow ' : 'dropdown-btn ') + (opts.className ?? ''),
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  }) as HTMLButtonElement;
  const main = opts.split ? (h('button', { class: 'split-main', type: 'button' }) as HTMLButtonElement) : null;
  if (main) main.addEventListener('click', () => opts.split!.onMain(value));
  const el = main ? h('div', { class: 'split-btn ' + (opts.split!.className ?? ''), role: 'group', 'aria-label': opts.name }, main, btn) : btn;

  const render = () => {
    const o = opts.options.find((x) => x.value === value) ?? opts.options[0];
    if (main) {
      main.innerHTML = o.icon ?? '';
      main.setAttribute('aria-label', `${opts.name}: ${o.label}`);
      main.title = opts.split!.title?.(`${opts.name}: ${o.label}`) ?? `${opts.name}: ${o.label}`;
      btn.innerHTML = icons.chevron;
      btn.setAttribute('aria-label', `${opts.name} options`);
      btn.title = `${opts.name} options`;
      return;
    }
    btn.innerHTML = `${o.icon ?? ''}<span class="dropdown-label"></span>${icons.chevron}`;
    btn.querySelector('.dropdown-label')!.textContent = o.label;
    btn.setAttribute('aria-label', `${opts.name}: ${o.label}`);
    btn.title = `${opts.name}: ${o.label}`;
  };

  let menu: HTMLElement | null = null;
  const onOutside = (e: PointerEvent) => {
    if (menu && !menu.contains(e.target as Node) && !el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    // Keys the menu handles must not also reach the board's shortcuts (arrows step strips).
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[n]?.focus();
    } else if (e.key === 'Tab') close();
  };

  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openMenu?.close === close) openMenu = null;
  }

  function open() {
    openMenu?.close();
    menu = h('div', { class: 'dropdown-menu', role: 'menu', 'aria-label': opts.name });
    for (const o of opts.options) {
      const item = h('button', { class: 'dropdown-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(o.value === value) }) as HTMLButtonElement;
      item.innerHTML = `${o.icon ?? ''}<span class="dropdown-text"><b></b><small></small></span><kbd hidden></kbd>`;
      item.querySelector('b')!.textContent = o.label;
      item.querySelector('small')!.textContent = o.description ?? '';
      if (o.hint) {
        const k = item.querySelector('kbd')!;
        k.hidden = false;
        k.textContent = o.hint;
      }
      item.addEventListener('click', () => {
        close();
        if (o.value !== value || opts.reselect) opts.onSelect(o.value);
      });
      menu.append(item);
    }
    popupHost().append(menu);
    const r = appRect(el);
    const w = menu.offsetWidth;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, appViewport().width - w - 8))}px`;
    fitBelow(menu, r.bottom + 6);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    openMenu = { close };
    (menu.querySelector<HTMLElement>('[aria-checked=true]') ?? menu.querySelector<HTMLElement>('button'))?.focus();
  }

  btn.addEventListener('click', () => (menu ? close() : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !menu) {
      e.preventDefault();
      open();
    }
  });
  render();
  return {
    el,
    set(v: T) {
      value = v;
      render();
      // An open menu follows too (the choice can change from a keyboard shortcut while it is open).
      menu?.querySelectorAll('[role=menuitemradio]').forEach((item, i) => item.setAttribute('aria-checked', String(opts.options[i]?.value === v)));
    },
    close,
  };
}

/**
 * A panel anchored under a toolbar button (size slider, colour picker...). Closes on outside
 * press, Escape or resize. Only one popover/menu is open at a time.
 */
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { label: string; onClose?: () => void }) {
  openMenu?.close();
  const panel = h('div', { class: 'popover', role: 'dialog', 'aria-label': opts.label }, content);
  popupHost().append(panel);
  const r = appRect(anchor);
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - panel.offsetWidth / 2, appViewport().width - panel.offsetWidth - 8))}px`;
  fitBelow(panel, r.bottom + 6);
  anchor.setAttribute('aria-expanded', 'true');
  const onOutside = (e: PointerEvent) => {
    if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };
  function close() {
    if (!panel.isConnected) return;
    panel.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openMenu?.close === close) openMenu = null;
    opts.onClose?.();
  }
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  openMenu = { close };
  panel.querySelector<HTMLElement>('input, button')?.focus();
  return { close, panel };
}

/** Is a popover/menu open (so a second press on its button should just close it)? */
export const closeOpenMenu = () => {
  const had = !!openMenu;
  openMenu?.close();
  return had;
};
