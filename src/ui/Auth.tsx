import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_EMAIL, MAX_PASSWORD, MIN_PASSWORD } from '../limits';
import { passkeysSupported } from '../account';
import { EMAIL_COOLDOWN, emailLimit } from '../emailLimit';
import { Logo } from './Logo';
import { PasswordInput } from './PasswordInput';
import { PublicFooter } from './Public';
import { CaptchaSlot, useCaptcha } from './captcha';
import type { Captcha } from '../captcha';

type Mode = 'signin' | 'signup' | 'magic' | 'reset';
type Sent = 'signup' | 'magic' | 'reset';

export interface AuthProps {
  sb: SupabaseClient;
  initialMode: 'signin' | 'signup';
  /** Offer "Try it without an account" (shown to new visitors). */
  onTryLocal?: () => void;
  /** The visitor came from guest mode: explain that their notes will be saved, and offer a way back. */
  guest?: { noteCount: number; onBack: () => void };
}

const HEADINGS: Record<Mode, string> = { signin: 'Welcome back.', signup: 'Make room for your ideas.', magic: 'A link, and you’re in.', reset: 'Reset your password.' };
const SUBMIT: Record<Mode, string> = { signin: 'Sign in', signup: 'Create account', magic: 'Send sign-in link', reset: 'Send reset link' };

/** Counts a wait down, a second at a time; `left` is 0 when there is none. */
function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft] as const;
}

/** Sign-in, sign-up, email link and password reset. The app reacts to Supabase auth state changes, not to this screen. */
export function AuthScreen({ sb, initialMode, onTryLocal, guest }: AuthProps) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [msg, setMsgState] = useState<{ text: string; kind?: 'ok' | 'err' }>({ text: '' });
  const [sent, setSent] = useState<{ what: Sent; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [password, setPassword] = useState('');
  // Supabase's wait before the next email: the message counts down and the button stays off.
  const [wait, setWait] = useCountdown();
  const [waitText, setWaitText] = useState('');
  const email = useRef<HTMLInputElement>(null);
  const captcha = useCaptcha();
  const redirectTo = window.location.origin + '/';

  useEffect(() => {
    document.title = `${mode === 'signup' ? 'Create account' : 'Log in'} — Lineboard`;
  }, [mode]);

  const setMsg = (text: string, kind: 'ok' | 'err' = 'ok') => {
    setWait(0);
    setMsgState({ text, kind });
  };
  const switchMode = (m: Mode, clearPassword: boolean) => {
    setMode(m);
    if (clearPassword) setPassword('');
    setMsg('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('Please wait...');
    try {
      const em = (email.current?.value ?? '').trim();
      const captchaToken = await captcha?.take();
      if (mode === 'signin') {
        const { error } = await sb.auth.signInWithPassword({ email: em, password, options: { captchaToken } });
        if (error) throw error;
        setMsg('');
      } else if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: em, password, options: { emailRedirectTo: redirectTo, captchaToken } });
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
      const er = err as Error & { code?: string };
      const limit = emailLimit(er);
      if (limit?.wait) {
        setMsgState({ text: '', kind: 'err' });
        setWaitText(limit.text);
        setWait(limit.wait);
        return;
      }
      setMsg(limit ? limit.text : er.code === 'captcha_failed' ? 'The bot check failed. Try again.' : er.message || 'Something went wrong', 'err');
    } finally {
      setBusy(false);
    }
  };

  const showSent = (what: Sent, to: string) => {
    setMsg('');
    setSent({ what, to });
  };

  const passkey = async () => {
    setPasskeyBusy(true);
    setMsg('Follow your browser’s prompt...');
    try {
      const { error } = await sb.auth.signInWithPasskey({ options: { captchaToken: await captcha?.take() } });
      if (error) throw error;
      setMsg('');
    } catch (err) {
      const m = (err as Error).message || '';
      setMsg(/not allowed|abort|cancel|timed out/i.test(m) ? 'Passkey sign-in was cancelled.' : m || 'Passkey sign-in failed', 'err');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const noPassword = mode === 'magic' || mode === 'reset';
  const message = wait > 0 ? `${waitText} ${wait} second${wait === 1 ? '' : 's'}.` : msg.text;
  const messageClass = 'auth-msg' + (wait > 0 ? ' err' : msg.kind ? ' ' + msg.kind : '');

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <Logo />
          <span>Lineboard</span>
        </div>
        <a className="auth-home" href="/home">
          ← Back to home
        </a>
        <h1 className="auth-heading">{HEADINGS[mode]}</h1>
        <p className="tagline">{mode === 'signup' ? 'Create your free account to keep your notebooks in sync.' : 'Your notes are right where you left them.'}</p>
        <form className="auth-form" onSubmit={submit} hidden={!!sent}>
          <label>
            Email
            <input ref={email} type="email" placeholder="Email" autoComplete="email" required maxLength={MAX_EMAIL} />
          </label>
          <label className="password-label" hidden={noPassword}>
            Password
            <PasswordInput
              placeholder="Password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={mode === 'signin' || mode === 'signup'}
              style={noPassword ? { display: 'none' } : undefined}
              // New passwords have limits; signing in takes any length, so older passwords keep working.
              minLength={mode === 'signup' ? MIN_PASSWORD : undefined}
              maxLength={mode === 'signup' ? MAX_PASSWORD : undefined}
            />
          </label>
          <p className="auth-agreement" hidden={mode !== 'signup'}>
            By creating an account, you confirm you are at least 13 and agree to the{' '}
            <a href="/terms" target="_blank" rel="noopener">
              Terms of service
            </a>{' '}
            and acknowledge the{' '}
            <a href="/privacy" target="_blank" rel="noopener">
              Privacy policy
            </a>
            .
          </p>
          {!sent && <CaptchaSlot captcha={captcha} />}
          <button className="btn primary wide" type="submit" disabled={busy || wait > 0}>
            {SUBMIT[mode]}
          </button>
        </form>
        <button className="btn wide passkey-btn" type="button" hidden={!!sent || mode !== 'signin' || !passkeysSupported()} disabled={passkeyBusy} onClick={() => void passkey()}>
          Sign in with a passkey
        </button>
        <div className="auth-extra" hidden={!!sent}>
          {mode === 'signin' && (
            <button type="button" className="tab" onClick={() => switchMode('magic', true)}>
              Email me a sign-in link
            </button>
          )}
          {mode === 'magic' && (
            <button type="button" className="tab" onClick={() => switchMode('signin', true)}>
              Back to sign in
            </button>
          )}
          {(mode === 'signin' || mode === 'reset') && (
            <button type="button" className="link" onClick={() => switchMode(mode === 'reset' ? 'signin' : 'reset', false)}>
              {mode === 'reset' ? 'Back to sign in' : 'Forgot password?'}
            </button>
          )}
        </div>
        {sent && <SentView sb={sb} sent={sent} captcha={captcha} redirectTo={redirectTo} onBack={() => setSent(null)} />}
        <p className={messageClass} role="status">
          {message}
        </p>
        {guest ? (
          <div className="guest-box">
            <p>
              {guest.noteCount
                ? `Sign in or create a free account and the ${guest.noteCount === 1 ? 'note' : `${guest.noteCount} notes`} you made on this device will be saved to it.`
                : 'Sign in or create a free account to save your notes and use them on other devices.'}
            </p>
            <button type="button" className="link" onClick={guest.onBack}>
              Back to my notes without signing in
            </button>
          </div>
        ) : onTryLocal ? (
          <div className="guest-box">
            <div className="or">
              <span>or</span>
            </div>
            <button type="button" className="btn wide try-local" onClick={onTryLocal}>
              Try it without an account
            </button>
            <small>Your notes stay in this browser. Sign in any time to save them to an account.</small>
          </div>
        ) : null}
        <div className="auth-switch" hidden={!!sent}>
          <span>{mode === 'signup' ? 'Already have an account? ' : 'New to Lineboard? '}</span>
          <a href={mode === 'signup' ? '/login' : '/signup'}>{mode === 'signup' ? 'Log in' : 'Create account'}</a>
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}

/**
 * After an email is sent: say so plainly, with the address, and offer to send it again (after the
 * wait Supabase requires) instead of leaving the form up to be pressed again.
 */
function SentView({ sb, sent, captcha, redirectTo, onBack }: { sb: SupabaseClient; sent: { what: Sent; to: string }; captcha: Captcha | null; redirectTo: string; onBack: () => void }) {
  const { what, to } = sent;
  const [wait, setWait] = useCountdown();
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ text: string; err?: boolean }>({ text: '' });
  useEffect(() => setWait(EMAIL_COOLDOWN), [setWait]);
  const label = { signup: 'Resend confirmation email', magic: 'Resend sign-in link', reset: 'Resend reset link' }[what];
  const purpose = { signup: 'confirm your account', magic: 'sign in', reset: 'choose a new password' }[what];

  const resend = async () => {
    setSending(true);
    setStatus({ text: 'Sending...' });
    try {
      const captchaToken = await captcha?.take();
      const { error } =
        what === 'signup'
          ? await sb.auth.resend({ type: 'signup', email: to, options: { emailRedirectTo: redirectTo, captchaToken } })
          : what === 'magic'
            ? await sb.auth.signInWithOtp({ email: to, options: { emailRedirectTo: redirectTo, shouldCreateUser: false, captchaToken } })
            : await sb.auth.resetPasswordForEmail(to, { redirectTo, captchaToken });
      if (error) throw error;
      setStatus({ text: 'Sent again.' });
      setWait(EMAIL_COOLDOWN);
    } catch (err) {
      const limit = emailLimit(err as Error);
      setStatus({ text: limit ? (limit.wait ? `${limit.text} a moment.` : limit.text) : (err as Error).message || 'Could not send it.', err: true });
      if (limit?.wait) setWait(limit.wait);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="auth-sent">
      <h2>Check your email</h2>
      <p>
        We sent a link to <b>{to}</b>. Open it to {purpose}. It can take a minute to arrive; if it does not, check your spam folder.
      </p>
      {/* The bot check comes along (Resend needs it too, and it may ask for a click). */}
      <CaptchaSlot captcha={captcha} />
      <button className="btn wide" type="button" disabled={sending || wait > 0} onClick={() => void resend()}>
        {wait > 0 ? `${label} (${wait}s)` : label}
      </button>
      <p className={'auth-msg' + (status.err ? ' err' : '')} aria-live="polite">
        {status.text}
      </p>
      <button type="button" className="link" onClick={onBack}>
        Use a different email
      </button>
    </div>
  );
}

/** Shown after following a password-reset link. */
export function NewPasswordScreen({ sb, done }: { sb: SupabaseClient; done: () => void }) {
  const [password, setPassword] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg({ text: 'Please wait...' });
    const { error } = await sb.auth.updateUser({ password });
    if (error) return setMsg({ text: error.message, err: true });
    // Someone who reset their password may be locking out an intruder: end every other session.
    if (signOutOthers) {
      const { error: outErr } = await sb.auth.signOut({ scope: 'others' });
      if (outErr) console.warn('Could not sign out other devices', outErr);
    }
    done();
  };
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">
          <Logo />
          <span>Set a new password</span>
        </div>
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <label>
            New password
            <PasswordInput
              placeholder={`New password (at least ${MIN_PASSWORD} characters)`}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="set-check">
            <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} />
            <span>Sign out all other devices</span>
          </label>
          <button className="btn primary wide" type="submit">
            Set new password
          </button>
        </form>
        <p className={'auth-msg' + (msg.err ? ' err' : '')}>{msg.text}</p>
      </div>
    </div>
  );
}
