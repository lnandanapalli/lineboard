import { h } from './util';
import { appRect, appViewport } from './orientation';

/**
 * Full names for names cut short with "…" (long note and notebook titles in the sidebar): shown in
 * a small popup on hover, or on a long press on touch screens, where hover does not exist. Names
 * that fit are left alone. The popup wraps to a few lines and ends in "…" only past that.
 */
const LONG_PRESS_MS = 500;

export function attachNameTips(root: HTMLElement, selector: string) {
  let tip: HTMLElement | null = null;
  let press: ReturnType<typeof setTimeout> | null = null;
  let swallowClick = false;

  const truncated = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;

  const show = (el: HTMLElement) => {
    hide();
    if (!truncated(el)) return;
    tip = h('div', { class: 'name-tip', role: 'tooltip' }, el.textContent ?? '');
    (document.querySelector('.app') ?? document.body).append(tip);
    const r = appRect(el);
    const vw = appViewport().width;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
    const below = r.bottom + 6;
    tip.style.top = `${below + tip.offsetHeight > appViewport().height - 8 ? r.top - tip.offsetHeight - 6 : below}px`;
  };
  const hide = () => {
    tip?.remove();
    tip = null;
  };
  const target = (e: Event) => (e.target as Element | null)?.closest?.(selector) as HTMLElement | null;

  root.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const el = target(e);
    if (el && el.textContent !== tip?.textContent) show(el);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const el = target(e);
    if (el && !el.contains(e.relatedTarget as Node)) hide();
  });
  root.addEventListener('pointerdown', (e) => {
    hide();
    if (e.pointerType !== 'touch') return;
    const el = target(e);
    if (!el || !truncated(el)) return;
    press = setTimeout(() => {
      press = null;
      show(el);
      swallowClick = true; // the long press showed the name; releasing it should not also open the note
    }, LONG_PRESS_MS);
  });
  const cancel = () => {
    if (press) clearTimeout(press);
    press = null;
  };
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') cancel();
  });
  root.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
      setTimeout(hide, 1500);
    },
    true,
  );
  root.addEventListener('contextmenu', (e) => {
    if (target(e)) e.preventDefault(); // the long press is ours, not the browser's menu
  });
  root.addEventListener('scroll', hide, true);
  return hide;
}
