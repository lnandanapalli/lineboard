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

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
  }
  // Inside the app element when there is one, so it turns with a manually rotated app.
  const host = document.querySelector('.app') ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 5000 : 2500);
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

export function lsDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}

/** In-page confirm/prompt dialog. Resolves null on cancel. */
export function dialog(opts: {
  title: string;
  message?: string;
  input?: string;
  /** Show a list to pick from; resolves to the chosen value. */
  choices?: { value: string; label: string }[];
  ok?: string;
  danger?: boolean;
  /** A checkbox under the field; its state is written back to `value` when the dialog is confirmed. */
  check?: { label: string; value: boolean; hint?: string };
}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = opts.input !== undefined ? (h('input', { type: 'text', class: 'dlg-input' }) as HTMLInputElement) : null;
    if (input) input.value = opts.input!;
    const select = opts.choices
      ? (h('select', { class: 'dlg-input' }, ...opts.choices.map((c) => h('option', { value: c.value }, c.label))) as HTMLSelectElement)
      : null;
    const box = opts.check ? (h('input', { type: 'checkbox' }) as HTMLInputElement) : null;
    if (box) box.checked = opts.check!.value;
    const check = box ? h('label', { class: 'dlg-check' }, box, h('span', {}, opts.check!.label, opts.check!.hint ? h('small', {}, opts.check!.hint) : null)) : null;
    const okBtn = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'submit' }, opts.ok ?? 'OK');
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const form = h(
      'form',
      { method: 'dialog', class: 'dlg' },
      h('h3', {}, opts.title),
      opts.message ? h('p', {}, opts.message) : null,
      input,
      select,
      check,
      h('div', { class: 'dlg-actions' }, cancelBtn, okBtn),
    );
    const d = h('dialog', { class: 'modal small' }, form);
    document.body.append(d);
    const done = (v: string | null) => {
      d.close();
      d.remove();
      resolve(v);
    };
    cancelBtn.addEventListener('click', () => done(null));
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (box) opts.check!.value = box.checked;
      done(input ? input.value : select ? select.value : 'ok');
    });
    d.showModal();
    if (input) {
      input.focus();
      input.select();
    }
  });
}
