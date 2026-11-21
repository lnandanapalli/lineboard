import { icons } from './icons';
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

/** Sent on a form whose submit button runs its action itself (no native submit event). */
export const FORM_SENT = 'lb-form-sent';

/**
 * A password field with a show / hide button (the eye), so a typing mistake can be checked.
 * Pressing it keeps the caret in the field; the field goes back to hidden when the form is sent.
 */
export function withReveal(input: HTMLInputElement): HTMLElement {
  const btn = h('button', { class: 'reveal-btn', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', title: 'Show password' }) as HTMLButtonElement;
  const paint = () => {
    const shown = input.type === 'text';
    btn.innerHTML = shown ? icons.eyeOff : icons.eye;
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.title = shown ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-pressed', String(shown));
  };
  btn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the field
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    paint();
  });
  // Never leave a password showing once it has been used (the field joins its form right after).
  // Forms that run their action in a click handler send FORM_SENT instead of a submit event.
  const hide = () => {
    input.type = 'password';
    paint();
  };
  queueMicrotask(() => {
    input.form?.addEventListener('submit', hide);
    input.form?.addEventListener(FORM_SENT, hide);
  });
  paint();
  return h('span', { class: 'reveal' }, input, btn);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a: A) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Save to localStorage; false when it could not be kept (storage full or unavailable). */
export function lsSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function lsDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}
