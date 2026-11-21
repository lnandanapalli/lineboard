import { icons } from './icons';
import { h } from './util';
import { closeOpenMenu, popover } from './ui/overlays';

// Popovers, menus and dialogs are drawn by React now (ui/overlays.tsx).
export { actionMenu, closeOpenMenu, popover, type ActionItem } from './ui/overlays';

/**
 * An ⓘ button that explains a setting in a small popup, so the screen shows the controls and the
 * explanation is one tap away (as in most apps' settings). Safe inside a <label>: pressing it
 * does not also toggle or focus the labelled control. (For screens not yet in React; React ones
 * use InfoButton.)
 */
export function infoButton(topic: string, text: string): HTMLButtonElement {
  const b = h('button', { class: 'info-btn', type: 'button', 'aria-label': `About ${topic}`, title: `About ${topic}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
  b.innerHTML = icons.info;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.getAttribute('aria-expanded') === 'true') return void closeOpenMenu();
    popover(b, h('p', { class: 'info-text' }, text), { label: topic });
  });
  return b;
}

/** A heading with its explanation behind an ⓘ. */
export function infoHeading(tag: 'h4' | 'h3', title: string, text?: string | null) {
  return h(tag, { class: 'with-info' }, h('span', {}, title), text ? infoButton(title, text) : null);
}
