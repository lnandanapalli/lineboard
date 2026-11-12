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
    document.body.append(el);
  }
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

/** In-page confirm/prompt dialog. Resolves null on cancel. */
export function dialog(opts: { title: string; message?: string; input?: string; ok?: string; danger?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const input = opts.input !== undefined ? (h('input', { type: 'text', class: 'dlg-input' }) as HTMLInputElement) : null;
    if (input) input.value = opts.input!;
    const okBtn = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'submit' }, opts.ok ?? 'OK');
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const form = h(
      'form',
      { method: 'dialog', class: 'dlg' },
      h('h3', {}, opts.title),
      opts.message ? h('p', {}, opts.message) : null,
      input,
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
      done(input ? input.value : 'ok');
    });
    d.showModal();
    if (input) {
      input.focus();
      input.select();
    }
  });
}
