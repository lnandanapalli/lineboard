import type { SupabaseClient } from '@supabase/supabase-js';
import { h } from './util';
import { publicFooter } from './public';
import { logo } from './brand';

type Mode = 'signin' | 'signup' | 'magic' | 'reset';

export interface AuthOptions {
  initialMode?: 'signin' | 'signup';
  /** Offer "Try it without an account" (shown to new visitors). */
  onTryLocal?: () => void;
  /** The visitor came from guest mode: explain that their notes will be saved, and offer a way back. */
  guest?: { noteCount: number; onBack: () => void };
}

/** Renders the sign-in screen. The app reacts to Supabase auth state changes, not to this function. */
export function renderAuth(root: HTMLElement, sb: SupabaseClient, opts: AuthOptions = {}) {
  let mode: Mode = opts.initialMode ?? 'signin';
  const redirectTo = window.location.origin + '/';

  const msg = h('p', { class: 'auth-msg', role: 'status' });
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'email', required: true }) as HTMLInputElement;
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', minlength: '6' }) as HTMLInputElement;
  const submit = h('button', { class: 'btn primary wide', type: 'submit' });
  const tabs = h('div', { class: 'auth-switch' });
  const heading = h('h1', { class: 'auth-heading' });
  const description = h('p', { class: 'tagline' });
  const agreement = h('p', { class: 'auth-agreement' }, 'By creating an account, you agree to the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of service'), ' and acknowledge the ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy policy'), '.');
  const extra = h('div', { class: 'auth-extra' });
  const form = h('form', { class: 'auth-form' }, h('label', {}, 'Email', email), h('label', { class: 'password-label' }, 'Password', pass), agreement, submit);

  const setMsg = (t: string, kind: 'ok' | 'err' = 'ok') => {
    msg.textContent = t;
    msg.className = 'auth-msg ' + kind;
  };

  const tab = (m: Mode, label: string) => {
    const b = h('button', { type: 'button', class: 'tab' + (mode === m ? ' active' : '') }, label);
    b.addEventListener('click', () => {
      mode = m;
      pass.value = '';
      setMsg('');
      render();
    });
    return b;
  };

  function render() {
    heading.textContent = { signin: 'Welcome back.', signup: 'Make room for your ideas.', magic: 'A link, and you’re in.', reset: 'Reset your password.' }[mode];
    document.title = `${mode === 'signup' ? 'Create account' : 'Log in'} — Lineboard`;
    description.textContent = mode === 'signup' ? 'Create your free account to keep your notebooks in sync.' : 'Your notes are right where you left them.';
    tabs.replaceChildren(h('span', {}, mode === 'signup' ? 'Already have an account? ' : 'New to Lineboard? '), h('a', { href: mode === 'signup' ? '/login' : '/signup' }, mode === 'signup' ? 'Log in' : 'Create account'));
    agreement.hidden = mode !== 'signup';
    form.querySelector<HTMLElement>('.password-label')!.hidden = mode === 'magic' || mode === 'reset';
    pass.style.display = mode === 'magic' || mode === 'reset' ? 'none' : '';
    pass.required = mode === 'signin' || mode === 'signup';
    pass.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    submit.textContent = { signin: 'Sign in', signup: 'Create account', magic: 'Send sign-in link', reset: 'Send reset link' }[mode];
    extra.replaceChildren();
    if (mode === 'signin') extra.append(tab('magic', 'Email me a sign-in link'));
    if (mode === 'magic') extra.append(tab('signin', 'Back to sign in'));
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
        const { error } = await sb.auth.signInWithOtp({ email: em, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
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
        h('a', { class: 'auth-home', href: '/home' }, '← Back to home'),
        heading,
        description,
        form,
        extra,
        msg,
        guestBox,
        tabs,
      ),
      publicFooter(),
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
