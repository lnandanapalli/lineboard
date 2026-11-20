import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_EMAIL, MAX_PASSWORD } from './limits';
import { h, withReveal } from './util';
import { publicFooter } from './public';
import { logo } from './brand';
import { passkeysSupported } from './account';
import { Captcha } from './captcha';
import { EMAIL_COOLDOWN, emailLimit } from './emailLimit';

type Mode = 'signin' | 'signup' | 'magic' | 'reset';
/** Shortest password accepted for new passwords; keep in step with the project's Auth setting. */
export const MIN_PASSWORD = 8;

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
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'email', required: true, maxlength: String(MAX_EMAIL) }) as HTMLInputElement;
  // Sign-in takes the password as typed (no length cap, so an older password is never cut short); new
  // passwords are limited where they are chosen.
  const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' }) as HTMLInputElement;
  const submit = h('button', { class: 'btn primary wide', type: 'submit' });
  const tabs = h('div', { class: 'auth-switch' });
  const heading = h('h1', { class: 'auth-heading' });
  const description = h('p', { class: 'tagline' });
  const agreement = h('p', { class: 'auth-agreement' }, 'By creating an account, you confirm you are at least 13 and agree to the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of service'), ' and acknowledge the ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy policy'), '.');
  const extra = h('div', { class: 'auth-extra' });
  // Bot check (only when configured): sign-in, sign-up, email links, resets and passkeys need a token.
  const captcha = new Captcha();
  const form = h('form', { class: 'auth-form' }, h('label', {}, 'Email', email), h('label', { class: 'password-label' }, 'Password', withReveal(pass)), agreement, captcha.el, submit);

  const setMsg = (t: string, kind: 'ok' | 'err' = 'ok') => {
    stopCountdown();
    msg.textContent = t;
    msg.className = 'auth-msg ' + kind;
  };

  // A wait before the next email: the message counts down and the button stays off until it ends.
  let countdown: ReturnType<typeof setInterval> | null = null;
  /** The form's own button is waiting out Supabase's email wait. */
  let submitHeld = false;
  function stopCountdown() {
    if (countdown) clearInterval(countdown);
    countdown = null;
    if (submitHeld) {
      submitHeld = false;
      submit.disabled = false;
    }
  }
  const waitThen = (button: HTMLButtonElement, seconds: number, show: (left: number) => void, done: () => void) => {
    stopCountdown();
    let left = seconds;
    button.disabled = true;
    show(left);
    countdown = setInterval(() => {
      left--;
      if (left > 0) return show(left);
      stopCountdown();
      button.disabled = false;
      done();
    }, 1000);
  };

  // After an email is sent: say so plainly, with the address, and offer to send it again (after
  // the wait Supabase requires) instead of leaving the form up to be pressed again.
  const sent = h('div', { class: 'auth-sent', hidden: true });
  const showSent = (what: 'signup' | 'magic' | 'reset', to: string) => {
    const resend = h('button', { class: 'btn wide', type: 'button' }) as HTMLButtonElement;
    const label = { signup: 'Resend confirmation email', magic: 'Resend sign-in link', reset: 'Resend reset link' }[what];
    const status = h('p', { class: 'auth-msg', 'aria-live': 'polite' });
    const startWait = (seconds: number) =>
      waitThen(resend, seconds, (left) => (resend.textContent = `${label} (${left}s)`), () => (resend.textContent = label));
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      status.textContent = 'Sending...';
      status.className = 'auth-msg';
      try {
        const captchaToken = await captcha.take();
        const { error } =
          what === 'signup'
            ? await sb.auth.resend({ type: 'signup', email: to, options: { emailRedirectTo: redirectTo, captchaToken } })
            : what === 'magic'
              ? await sb.auth.signInWithOtp({ email: to, options: { emailRedirectTo: redirectTo, shouldCreateUser: false, captchaToken } })
              : await sb.auth.resetPasswordForEmail(to, { redirectTo, captchaToken });
        if (error) throw error;
        status.textContent = 'Sent again.';
        startWait(EMAIL_COOLDOWN);
      } catch (err) {
        const limit = emailLimit(err as Error);
        status.textContent = limit ? (limit.wait ? `${limit.text} a moment.` : limit.text) : (err as Error).message || 'Could not send it.';
        status.className = 'auth-msg err';
        if (limit?.wait) startWait(limit.wait);
        else resend.disabled = false;
      }
    });
    const back = h('button', { type: 'button', class: 'link' }, 'Use a different email');
    back.addEventListener('click', () => {
      stopCountdown();
      form.insertBefore(captcha.el, submit); // back where it was
      sent.hidden = true;
      for (const el of [form, extra, tabs]) el.hidden = false;
      render();
    });
    const what2 = { signup: 'confirm your account', magic: 'sign in', reset: 'choose a new password' }[what];
    sent.replaceChildren(
      h('h2', {}, 'Check your email'),
      h('p', {}, 'We sent a link to ', h('b', {}, to), `. Open it to ${what2}. It can take a minute to arrive; if it does not, check your spam folder.`),
      resend,
      status,
      back,
    );
    for (const el of [form, extra, tabs, passkeyBtn]) el.hidden = true;
    // The bot check comes along (Resend needs it too, and it may ask for a click).
    sent.insertBefore(captcha.el, resend);
    setMsg('');
    sent.hidden = false;
    startWait(EMAIL_COOLDOWN);
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
    // New passwords: at least MIN_PASSWORD (as in the Supabase project's settings). Signing in takes
    // any length, so older, shorter passwords keep working.
    if (mode === 'signup') {
      pass.minLength = MIN_PASSWORD;
      pass.maxLength = MAX_PASSWORD;
    } else {
      pass.removeAttribute('minlength');
      pass.removeAttribute('maxlength');
    }
    submit.textContent = { signin: 'Sign in', signup: 'Create account', magic: 'Send sign-in link', reset: 'Send reset link' }[mode];
    extra.replaceChildren();
    passkeyBtn.hidden = mode !== 'signin' || !passkeysSupported();
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

  // Passkey sign-in (no email or password needed; the passkey identifies the account).
  const passkeyBtn = h('button', { class: 'btn wide passkey-btn', type: 'button' }, 'Sign in with a passkey') as HTMLButtonElement;
  passkeyBtn.addEventListener('click', async () => {
    passkeyBtn.disabled = true;
    setMsg('Follow your browser’s prompt...');
    try {
      const { error } = await sb.auth.signInWithPasskey({ options: { captchaToken: await captcha.take() } });
      if (error) throw error;
      setMsg('');
    } catch (err) {
      const m = (err as Error).message || '';
      setMsg(/not allowed|abort|cancel|timed out/i.test(m) ? 'Passkey sign-in was cancelled.' : m || 'Passkey sign-in failed', 'err');
    } finally {
      passkeyBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    setMsg('Please wait...');
    try {
      const em = email.value.trim();
      const captchaToken = await captcha.take();
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email: em, password: pass.value, options: { captchaToken } });
        if (error) throw error;
        setMsg('');
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: em, password: pass.value, options: { emailRedirectTo: redirectTo, captchaToken } });
        if (error) throw error;
        if (!data.session) showSent('signup', em);
      } else if (mode === 'magic') {
        const { error } = await sb.auth.signInWithOtp({ email: em, options: { emailRedirectTo: redirectTo, shouldCreateUser: false, captchaToken } });
        if (error) throw error;
        showSent('magic', em);
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo, captchaToken });
        if (error) throw error;
        showSent('reset', em);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      const limit = emailLimit(e);
      if (limit?.wait) {
        // Supabase's wait between two emails: count it down, and keep the button off meanwhile.
        const label = submit.textContent;
        waitThen(submit, limit.wait, (left) => {
          msg.textContent = `${limit.text} ${left} second${left === 1 ? '' : 's'}.`;
          msg.className = 'auth-msg err';
        }, () => {
          submitHeld = false;
          msg.textContent = '';
          submit.textContent = label;
        });
        submitHeld = true;
        return;
      }
      setMsg(limit ? limit.text : e.code === 'captcha_failed' ? 'The bot check failed. Try again.' : e.message || 'Something went wrong', 'err');
    } finally {
      if (!submitHeld) submit.disabled = false;
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
        passkeyBtn,
        extra,
        sent,
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
  const pass = h('input', { type: 'password', placeholder: `New password (at least ${MIN_PASSWORD} characters)`, autocomplete: 'new-password', minlength: String(MIN_PASSWORD), maxlength: String(MAX_PASSWORD), required: true }) as HTMLInputElement;
  const msg = h('p', { class: 'auth-msg' });
  const form = h('form', { class: 'auth-form' }, h('label', {}, 'New password', withReveal(pass)), h('button', { class: 'btn primary wide', type: 'submit' }, 'Set new password'));
  const others = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  form.insertBefore(h('label', { class: 'set-check' }, others, h('span', {}, 'Sign out all other devices')), form.lastChild);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = 'Please wait...';
    msg.className = 'auth-msg';
    const { error } = await sb.auth.updateUser({ password: pass.value });
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg err';
      return;
    }
    // Someone who reset their password may be locking out an intruder: end every other session.
    if (others.checked) {
      const { error: outErr } = await sb.auth.signOut({ scope: 'others' });
      if (outErr) console.warn('Could not sign out other devices', outErr);
    }
    done();
  });
  root.replaceChildren(
    h('div', { class: 'auth-screen' }, h('div', { class: 'auth-card' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Set a new password')), form, msg)),
  );
}
