import type { SupabaseClient } from '@supabase/supabase-js';
import { h } from './util';

type Mode = 'signin' | 'signup' | 'magic' | 'reset';

export interface AuthOptions {
  /** Offer "Try it without an account" (shown to new visitors). */
  onTryLocal?: () => void;
  /** The visitor came from guest mode: explain that their notes will be saved, and offer a way back. */
  guest?: { noteCount: number; onBack: () => void };
}

/** Renders the sign-in screen. The app reacts to Supabase auth state changes, not to this function. */
export function renderAuth(root: HTMLElement, sb: SupabaseClient, opts: AuthOptions = {}) {
  let mode: Mode = 'signin';
  const redirectTo = window.location.origin + window.location.pathname;

  const msg = h('p', { class: 'auth-msg', role: 'status' });
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'email', required: true }) as HTMLInputElement;
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', minlength: '6' }) as HTMLInputElement;
  const submit = h('button', { class: 'btn primary wide', type: 'submit' });
  const tabs = h('div', { class: 'auth-tabs' });
  const extra = h('div', { class: 'auth-extra' });
  const form = h('form', { class: 'auth-form' }, email, pass, submit);

  const setMsg = (t: string, kind: 'ok' | 'err' = 'ok') => {
    msg.textContent = t;
    msg.className = 'auth-msg ' + kind;
  };

  const tab = (m: Mode, label: string) => {
    const b = h('button', { type: 'button', class: 'tab' + (mode === m ? ' active' : '') }, label);
    b.addEventListener('click', () => {
      mode = m;
      setMsg('');
      render();
    });
    return b;
  };

  function render() {
    tabs.replaceChildren(tab('signin', 'Sign in'), tab('signup', 'Create account'), tab('magic', 'Email link'));
    pass.style.display = mode === 'magic' || mode === 'reset' ? 'none' : '';
    pass.required = mode === 'signin' || mode === 'signup';
    pass.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    submit.textContent = { signin: 'Sign in', signup: 'Create account', magic: 'Send sign-in link', reset: 'Send reset link' }[mode];
    extra.replaceChildren();
    if (mode === 'signin' || mode === 'reset') {
      const a = h('button', { type: 'button', class: 'link' }, mode === 'reset' ? 'Back to sign in' : 'Forgot password?');
      a.addEventListener('click', () => {
        mode = mode === 'reset' ? 'signin' : 'reset';
        setMsg('');
        render();
      });
      extra.append(a);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    setMsg('Please wait...');
    try {
      const em = email.value.trim();
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email: em, password: pass.value });
        if (error) throw error;
        setMsg('');
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: em, password: pass.value, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        if (!data.session) setMsg('Check your email to confirm your account, then come back here.');
      } else if (mode === 'magic') {
        const { error } = await sb.auth.signInWithOtp({ email: em, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        setMsg('Sign-in link sent. Open it on this device.');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo });
        if (error) throw error;
        setMsg('Password reset link sent.');
      }
    } catch (err) {
      setMsg((err as Error).message || 'Something went wrong', 'err');
    } finally {
      submit.disabled = false;
    }
  });

  render();

  let guestBox: HTMLElement | null = null;
  if (opts.guest) {
    const n = opts.guest.noteCount;
    const back = h('button', { type: 'button', class: 'link' }, 'Back to my notes without signing in');
    back.addEventListener('click', opts.guest.onBack);
    guestBox = h(
      'div',
      { class: 'guest-box' },
      h(
        'p',
        {},
        n
          ? `Sign in or create a free account and the ${n === 1 ? 'note' : `${n} notes`} you made on this device will be saved to it.`
          : 'Sign in or create a free account to save your notes and use them on other devices.',
      ),
      back,
    );
  } else if (opts.onTryLocal) {
    const tryBtn = h('button', { type: 'button', class: 'btn wide try-local' }, 'Try it without an account');
    tryBtn.addEventListener('click', opts.onTryLocal);
    guestBox = h(
      'div',
      { class: 'guest-box' },
      h('div', { class: 'or' }, h('span', {}, 'or')),
      tryBtn,
      h('small', {}, 'Your notes stay in this browser. Sign in any time to save them to an account.'),
    );
  }

  root.replaceChildren(
    h(
      'div',
      { class: 'auth-screen' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')),
        h('p', { class: 'tagline' }, 'Handwritten notes that ignore your palm.'),
        tabs,
        form,
        extra,
        msg,
        guestBox,
      ),
    ),
  );
}

/** Shown after following a password-reset link. */
export function renderNewPassword(root: HTMLElement, sb: SupabaseClient, done: () => void) {
  const pass = h('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password', minlength: '6', required: true }) as HTMLInputElement;
  const msg = h('p', { class: 'auth-msg' });
  const form = h('form', { class: 'auth-form' }, pass, h('button', { class: 'btn primary wide', type: 'submit' }, 'Set new password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: pass.value });
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg err';
    } else done();
  });
  root.replaceChildren(
    h('div', { class: 'auth-screen' }, h('div', { class: 'auth-card' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Set a new password')), form, msg)),
  );
}

export function logo(): HTMLElement {
  const s = h('span', { class: 'logo' });
  s.innerHTML =
    '<svg viewBox="0 0 32 32" width="28" height="28"><rect width="32" height="32" rx="7" fill="#111827"/><rect x="5" y="7" width="22" height="5" rx="1.5" fill="#374151"/><rect x="5" y="14" width="22" height="5" rx="1.5" fill="#fff"/><rect x="5" y="21" width="22" height="5" rx="1.5" fill="#374151"/><path d="M8 17c2-2 3 1 5-1s3 1 5-1 3 1 5 0" stroke="#2563eb" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
  return s;
}
