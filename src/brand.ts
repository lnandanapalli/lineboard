import { h } from './util';

export function logo(): HTMLElement {
  const s = h('span', { class: 'logo' });
  s.innerHTML =
    '<svg viewBox="0 0 32 32" width="28" height="28"><rect width="32" height="32" rx="7" fill="#111827"/><rect x="5" y="7" width="22" height="5" rx="1.5" fill="#374151"/><rect x="5" y="14" width="22" height="5" rx="1.5" fill="#fff"/><rect x="5" y="21" width="22" height="5" rx="1.5" fill="#374151"/><path d="M8 17c2-2 3 1 5-1s3 1 5-1 3 1 5 0" stroke="#2563eb" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
  return s;
}
