import { useEffect, useState } from 'react';
import type { Factor } from '@supabase/supabase-js';
import { MAX_PASSWORD, MIN_PASSWORD } from '../limits';
import { AccountError, describeDevice, passkeysSupported, type AccountSecurity, type DeviceSession } from '../account';
import { dialog } from './overlays';
import { toast } from './Toast';
import { Card } from './Card';
import { useCaptcha, CaptchaSlot } from './captcha';
import { CardHead } from './Encryption';
import { Actions, Btn, Check, cleanCode, CodeInput, codeProblem, ErrorLine, Field, openSteps, PassInput, Step, StepForm, useAction, type StepCtl } from './steps';

/**
 * "Sign-in & devices" settings (password, two-step verification, passkeys, signed-in devices) and
 * the second-step screen shown after signing in when two-step verification is on.
 */

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso: string | undefined | null): string {
  if (!iso) return 'never';
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rel.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rel.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return rel.format(Math.round(s / 86400), 'day');
  return dateFmt.format(new Date(iso));
}

// ----------------------------- settings pane -----------------------------

type Loaded<T> = { k: 'loading' } | { k: 'error'; e: unknown } | { k: 'ok'; data: T };

/** Load `fn` when shown and whenever `rev` changes; `reload` loads again. */
function useLoad<T>(fn: () => Promise<T>, rev = 0): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ k: 'loading' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ k: 'loading' });
    fn().then(
      (data) => live && setState({ k: 'ok', data }),
      (e) => live && setState({ k: 'error', e }),
    );
    return () => {
      live = false;
    };
  }, [n, rev]);
  return [state, () => setN((x) => x + 1)];
}

/** Loading... or the error, under the card's plain heading. */
function Pending({ title, state }: { title: string; state: Loaded<unknown> }) {
  return <Card title={title}>{state.k === 'error' ? <p className="enc-error">{(state.e as Error).message}</p> : <p className="muted">Loading...</p>}</Card>;
}

/** Password, two-step verification, passkeys and signed-in devices. Loads from the server when shown. */
export function SecurityPane({ account, email }: { account: AccountSecurity; email: string | null }) {
  const [devicesRev, setDevicesRev] = useState(0);
  return (
    <div className="pane-stack">
      <Card title="Password" info="Changing your password signs you out on every other device.">
        <div className="set-buttons">
          <Btn label="Change password" onClick={() => void changePasswordDialog(account, email)} />
        </div>
      </Card>
      <MfaCard account={account} email={email} devicesChanged={() => setDevicesRev((n) => n + 1)} />
      <PasskeyCard account={account} email={email} />
      <DevicesCard account={account} rev={devicesRev} />
    </div>
  );
}

const MFA_INFO =
  'Signing in also asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy...), as well as your password or passkey. Add the same account to a second phone or password manager as a backup, in case you lose the first.';

function MfaCard({ account, email, devicesChanged }: { account: AccountSecurity; email: string | null; devicesChanged: () => void }) {
  const [state, reload] = useLoad(() => account.authenticators());
  if (state.k !== 'ok') return <Pending title="Two-step verification" state={state} />;
  const list = state.data;
  const remove = async (f: Factor) => {
    const last = list.length === 1;
    const ok = await dialog({
      title: 'Remove this authenticator?',
      message: last
        ? 'This is your only authenticator, so two-step verification will be turned off. Signing in will need only your password or passkey.'
        : `"${f.friendly_name || 'Authenticator app'}" will no longer be accepted for sign-in.`,
      ok: 'Remove',
      danger: true,
    });
    if (!ok || !(await confirmItsYou(account, email))) return;
    try {
      await account.removeAuthenticator(f.id);
      toast(last ? 'Two-step verification is off.' : 'Authenticator removed.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    reload();
  };
  const add = async () => {
    if (!(await confirmItsYou(account, email))) return;
    if (await addAuthenticatorDialog(account, list.length)) reload();
    devicesChanged();
  };
  return (
    <Card title="Two-step verification" info={MFA_INFO}>
      <div className="set-switch">
        <div className="set-label">Authenticator app</div>
        <span className={'pill ' + (list.length ? 'on' : '')}>{list.length ? 'On' : 'Off'}</span>
      </div>
      {list.length > 0 && (
        <ul className="item-list">
          {list.map((f) => (
            <li key={f.id} className="item-row">
              <div className="item-main">
                <b>{f.friendly_name || 'Authenticator app'}</b>
                <small className="muted">{`Added ${dateFmt.format(new Date(f.created_at))}`}</small>
              </div>
              <Btn label="Remove" onClick={() => void remove(f)} />
            </li>
          ))}
        </ul>
      )}
      <div className="set-buttons">
        <Btn label={list.length ? 'Add another authenticator' : 'Set up authenticator app'} cls={list.length ? '' : 'primary'} onClick={() => void add()} />
      </div>
    </Card>
  );
}

const PASSKEY_INFO = 'Sign in with your fingerprint, face or device PIN instead of typing a password. Passkeys cannot be phished or reused.';

function PasskeyCard({ account, email }: { account: AccountSecurity; email: string | null }) {
  const supported = passkeysSupported();
  const [state, reload] = useLoad(() => (supported ? account.passkeys() : Promise.resolve([])));
  if (!supported)
    return (
      <Card title="Passkeys" info={PASSKEY_INFO}>
        <p className="muted">This browser does not support passkeys.</p>
      </Card>
    );
  if (state.k === 'loading') return <Pending title="Passkeys" state={state} />;
  if (state.k === 'error')
    return (
      <Card title="Passkeys" info={PASSKEY_INFO}>
        <p className="muted">{'Passkeys are not turned on for this Lineboard server yet. ' + (state.e instanceof AccountError && state.e.code ? '' : `(${(state.e as Error).message})`)}</p>
      </Card>
    );
  const list = state.data;
  const rename = async (id: string, name: string) => {
    const next = await dialog({ title: 'Rename passkey', input: name, ok: 'Rename' });
    if (next === null) return;
    try {
      await account.renamePasskey(id, next.trim() || 'Passkey');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    reload();
  };
  const remove = async (id: string, name: string) => {
    const ok = await dialog({
      title: 'Remove this passkey?',
      message: `"${name}" will no longer sign you in. Also delete it from the device or password manager that holds it.`,
      ok: 'Remove',
      danger: true,
    });
    if (!ok || !(await confirmItsYou(account, email))) return;
    try {
      await account.removePasskey(id);
      toast('Passkey removed.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    reload();
  };
  const add = async () => {
    if (!(await confirmItsYou(account, email))) return;
    const guess = navigator.userAgent ? describeDevice(navigator.userAgent) : 'Passkey';
    const name = await dialog({ title: 'Add a passkey', message: 'Give it a name you will recognise, then follow your browser’s prompt.', input: guess, ok: 'Continue' });
    if (name === null) return;
    try {
      await account.addPasskey(name.trim());
      toast('Passkey added. You can now sign in with it.');
    } catch (e) {
      const msg = (e as Error).message;
      if (!/abort|cancel|not allowed/i.test(msg)) toast(msg, 'error');
    }
    reload();
  };
  return (
    <Card title="Passkeys" info={PASSKEY_INFO}>
      {list.length > 0 && (
        <ul className="item-list">
          {list.map((p) => {
            const name = p.friendly_name || 'Passkey';
            return (
              <li key={p.id} className="item-row">
                <div className="item-main">
                  <b>{name}</b>
                  <small className="muted">{`Added ${dateFmt.format(new Date(p.created_at))} · last used ${ago(p.last_used_at)}`}</small>
                </div>
                <div className="item-actions">
                  <Btn label="Rename" onClick={() => void rename(p.id, name)} />
                  <Btn label="Remove" onClick={() => void remove(p.id, name)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="set-buttons">
        <Btn label="Add a passkey" onClick={() => void add()} />
      </div>
    </Card>
  );
}

function DevicesCard({ account, rev }: { account: AccountSecurity; rev: number }) {
  const [state, reload] = useLoad<DeviceSession[]>(() => account.listSessions(), rev);
  if (state.k !== 'ok') return <Pending title="Signed-in devices" state={state} />;
  const sessions = state.data;
  const others = sessions.filter((s) => !s.is_current).length;
  const signOut = async (s: DeviceSession, name: string) => {
    const ok = await dialog({ title: `Sign out ${name}?`, message: 'That device loses access right away and has to sign in again.', ok: 'Sign out', danger: true });
    if (!ok) return;
    try {
      await account.revokeSession(s.id);
      toast(`${name} signed out.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    reload();
  };
  const signOutOthers = async () => {
    const ok = await dialog({
      title: 'Sign out all other devices?',
      message: `${others === 1 ? '1 other device' : `${others} other devices`} will be signed out and lose access right away. This device stays signed in.`,
      ok: 'Sign out others',
      danger: true,
    });
    if (!ok) return;
    try {
      await account.signOutOthers();
      toast('Signed out of all other devices.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    reload();
  };
  return (
    <Card title="Signed-in devices" info="Devices where you’re signed in to your account. Sign out any you don’t recognise, then change your password.">
      <ul className="item-list">
        {sessions.map((s) => {
          const name = describeDevice(s.user_agent);
          const meta = [s.is_current ? 'This device' : `Active ${ago(s.last_active)}`, `signed in ${dateFmt.format(new Date(s.created_at))}`, s.ip].filter(Boolean).join(' · ');
          return (
            <li key={s.id} className={'item-row' + (s.is_current ? ' current' : '')}>
              <div className="item-main">
                <b>{name}</b>
                <small className="muted">{meta}</small>
              </div>
              {s.is_current ? <span className="pill on">This device</span> : <Btn label="Sign out" onClick={() => void signOut(s, name)} />}
            </li>
          );
        })}
      </ul>
      <div className="set-buttons">
        <button className="btn" type="button" disabled={others === 0} onClick={() => void signOutOthers()}>
          Sign out all other devices
        </button>
      </div>
    </Card>
  );
}

// ----------------------------- dialogs -----------------------------

/**
 * Ask for the account password (or an authenticator code) before a risky change, unless the user
 * confirmed in the last few minutes. Resolves false if they cancel.
 */
export async function confirmItsYou(account: AccountSecurity, email: string | null, why = 'This change affects how your account is protected.'): Promise<boolean> {
  // With two-step verification on, both the password and a code are needed: otherwise a stolen
  // password alone would get past the second step for every sensitive action.
  let factors: Factor[];
  try {
    factors = await account.authenticators();
  } catch (e) {
    toast((e as Error).message || 'Could not check your sign-in methods. Try again.', 'error');
    return false;
  }
  const needCode = factors.length > 0;
  const needPassword = !account.passwordRecent;
  if (!needPassword && (!needCode || account.codeRecent)) return true;
  const result = { ok: false };
  await openSteps('confirm-dialog', (ctl) => <ConfirmFlow account={account} email={email} why={why} factors={factors} needPassword={needPassword} ctl={ctl} result={result} />);
  return result.ok;
}

function ConfirmFlow(p: { account: AccountSecurity; email: string | null; why: string; factors: Factor[]; needPassword: boolean; ctl: StepCtl; result: { ok: boolean } }) {
  const { account, factors, ctl } = p;
  const needCode = factors.length > 0;
  const steps = (p.needPassword ? 1 : 0) + (needCode && !account.codeRecent ? 1 : 0);
  const [step, setStep] = useState<'password' | 'code'>(p.needPassword ? 'password' : 'code');
  const heading = (n: number) => <h3>{steps > 1 ? `Confirm it’s you (step ${n} of 2)` : 'Confirm it’s you'}</h3>;
  const confirmed = () => {
    p.result.ok = true;
    ctl.close();
  };
  if (step === 'password')
    return (
      <ConfirmPassword
        key="password"
        heading={heading(1)}
        why={p.why}
        email={p.email}
        account={account}
        cancel={ctl.close}
        next={() => (needCode && !account.codeRecent ? setStep('code') : confirmed())}
      />
    );
  const n = p.needPassword ? 2 : 1;
  return <ConfirmCode key="code" heading={heading(n)} text={(n > 1 ? 'Two-step verification is on, so a code is needed as well. ' : p.why + ' ') + 'Enter the 6-digit code from your authenticator app.'} account={account} factor={factors[0]} cancel={ctl.close} next={confirmed} />;
}

function ConfirmPassword({ heading, why, email, account, cancel, next }: { heading: React.ReactNode; why: string; email: string | null; account: AccountSecurity; cancel: () => void; next: () => void }) {
  const [pass, setPass] = useState('');
  const captcha = useCaptcha();
  const a = useAction();
  return (
    <Step>
      {heading}
      <p>{why + ' Enter your password to continue.'}</p>
      <StepForm
        onSubmit={() => {
          if (!pass) return a.setErr('Enter your password.');
          if (!email) return a.setErr('This account has no email address to check the password against.');
          void a.run('Checking...', async () => {
            await account.verifyPassword(email, pass, await captcha?.take());
            next();
          });
        }}
      >
        <Field label="Password">
          <PassInput autoComplete="current-password" max={MAX_PASSWORD} value={pass} set={setPass} />
        </Field>
        <CaptchaSlot captcha={captcha} />
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Cancel" onClick={cancel} />
          <Btn label="Confirm" cls="primary" a={a} busy="Checking..." submit />
        </Actions>
      </StepForm>
      <small className="muted">Signed up with an email link or a passkey and never set a password? Set one first with Change password.</small>
    </Step>
  );
}

function ConfirmCode({ heading, text, account, factor, cancel, next }: { heading: React.ReactNode; text: string; account: AccountSecurity; factor: Factor; cancel: () => void; next: () => void }) {
  const [code, setCode] = useState('');
  const a = useAction();
  return (
    <Step>
      {heading}
      <p>{text}</p>
      <StepForm
        onSubmit={() => {
          const problem = codeProblem(code);
          if (problem) return a.setErr(problem);
          void a.run('Checking...', async () => {
            await account.confirmWithCode(factor.id, code);
            next();
          });
        }}
      >
        <Field label="6-digit code">
          <CodeInput value={code} set={setCode} />
        </Field>
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Cancel" onClick={cancel} />
          <Btn label="Confirm" cls="primary" a={a} busy="Checking..." submit />
        </Actions>
      </StepForm>
    </Step>
  );
}

export async function changePasswordDialog(account: AccountSecurity, email: string | null) {
  // Two-step verification on: a code from the authenticator app is needed as well, whichever way
  // the current password is proven (otherwise a stolen password could change the password).
  const factors = await account.authenticators().catch(() => null);
  if (!factors) return toast('Could not check your sign-in methods. Try again.', 'error');
  await openSteps('', (ctl) => <ChangePassword account={account} email={email} factors={factors} ctl={ctl} />);
}

function ChangePassword({ account, email, factors, ctl }: { account: AccountSecurity; email: string | null; factors: Factor[]; ctl: StepCtl }) {
  const [current, setCurrent] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [others, setOthers] = useState(true);
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  /** Accounts without a password (email link / passkey sign-up) confirm with an emailed code instead. */
  const [byEmail, setByEmail] = useState(false);
  const captcha = useCaptcha();
  const a = useAction();
  useEffect(() => {
    if (byEmail) document.querySelector<HTMLInputElement>('dialog[open] input[aria-label="Confirmation code from your email"]')?.focus();
  }, [byEmail]);
  const go = () => {
    if (!byEmail && !current) return a.setErr('Enter your current password.');
    if (p1.length < MIN_PASSWORD) return a.setErr(`Use at least ${MIN_PASSWORD} characters.`);
    if (p1.length > MAX_PASSWORD) return a.setErr(`Use at most ${MAX_PASSWORD} characters.`);
    if (p1 !== p2) return a.setErr('The two new passwords do not match.');
    if (byEmail && !/^\d{6,10}$/.test(cleanCode(code))) return a.setErr('Enter the code from the email.');
    const totpProblem = factors.length ? codeProblem(totp) : null;
    if (totpProblem) return a.setErr(totpProblem);
    void a.run('Saving...', async () => {
      if (factors.length) await account.confirmWithCode(factors[0].id, totp);
      try {
        if (byEmail) await account.changePassword(p1, { nonce: cleanCode(code) }, { signOutOthers: others });
        else await account.changePassword(p1, { currentPassword: current, email: email ?? '', captchaToken: await captcha?.take() }, { signOutOthers: others });
      } catch (e) {
        // The project wants an emailed code too (old session and "secure password change" on).
        if (e instanceof AccountError && e.code === 'reauthentication_needed') setByEmail(true);
        throw e;
      }
      ctl.close();
      toast(others ? 'Password changed. Other devices were signed out.' : 'Password changed.');
    });
  };
  return (
    <Step>
      <h3>Change password</h3>
      <p>This is the password you sign in with. If you use end-to-end encryption, your encryption passphrase does not change.</p>
      <StepForm onSubmit={go}>
        {!byEmail && (
          <Field label="Current password">
            <PassInput autoComplete="current-password" max={MAX_PASSWORD} value={current} set={setCurrent} />
          </Field>
        )}
        <Btn
          label="No password yet, or forgot it? Email me a code instead"
          cls="link-btn"
          a={a}
          busy="Sending..."
          hidden={byEmail}
          onClick={() =>
            void a.run('Sending...', async () => {
              await account.sendPasswordCode();
              setByEmail(true);
              toast(email ? `Code sent to ${email}.` : 'Code sent.');
            })
          }
        />
        {byEmail && (
          <Field label="Confirmation code from your email">
            <CodeInput value={code} set={setCode} label="Confirmation code from your email" />
          </Field>
        )}
        <Field label="New password" help={`At least ${MIN_PASSWORD} characters.`}>
          <PassInput autoComplete="new-password" max={MAX_PASSWORD} value={p1} set={setP1} />
        </Field>
        <Field label="Type the new password again">
          <PassInput autoComplete="new-password" max={MAX_PASSWORD} value={p2} set={setP2} />
        </Field>
        {factors.length > 0 && (
          <Field label="6-digit code from your authenticator app">
            <CodeInput value={totp} set={setTotp} label="6-digit code from your authenticator app" />
          </Field>
        )}
        <Check text="Sign out all other devices" on={others} set={setOthers} />
        <CaptchaSlot captcha={captcha} />
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Cancel" onClick={ctl.close} />
          <Btn label="Change password" cls="primary" a={a} busy="Saving..." submit />
        </Actions>
      </StepForm>
    </Step>
  );
}

/** Walk through adding an authenticator app. Resolves true when one was added. */
export async function addAuthenticatorDialog(account: AccountSecurity, existing: number): Promise<boolean> {
  const state = { factorId: null as string | null, added: false };
  // Started here, once (not from the dialog's effect, which development mode runs twice).
  const starting = account.startAuthenticator(existing ? `Authenticator ${existing + 1}` : 'Authenticator app');
  starting.then((s) => (state.factorId = s.factorId)).catch(() => {});
  await openSteps('mfa-dialog', (ctl) => <AddAuthenticator account={account} starting={starting} ctl={ctl} state={state} />);
  // A setup can still be on its way when the dialog closes: cancel it once it arrives.
  await starting.catch(() => {});
  if (state.factorId && !state.added) void account.cancelAuthenticator(state.factorId).catch(() => {});
  return state.added;
}

type AddStep = { k: 'starting' } | { k: 'scan'; qr: string; secret: string; factorId: string } | { k: 'done' } | { k: 'failed'; msg: string };

function AddAuthenticator({ account, starting, ctl, state }: { account: AccountSecurity; starting: ReturnType<AccountSecurity['startAuthenticator']>; ctl: StepCtl; state: { factorId: string | null; added: boolean } }) {
  const [step, setStep] = useState<AddStep>({ k: 'starting' });
  const [code, setCode] = useState('');
  const a = useAction();
  useEffect(() => {
    let live = true;
    starting.then(
      (started) => live && setStep({ k: 'scan', qr: started.qr, secret: started.secret, factorId: started.factorId }),
      (e) => live && setStep({ k: 'failed', msg: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [starting]);
  switch (step.k) {
    case 'starting':
      return (
        <Step key="starting">
          <h3>Set up an authenticator app</h3>
          <p>Getting a code...</p>
        </Step>
      );
    case 'failed':
      return (
        <Step key="failed">
          <h3>Could not start</h3>
          <p>{step.msg}</p>
          <Actions>
            <Btn label="Close" onClick={ctl.close} />
          </Actions>
        </Step>
      );
    case 'done':
      return (
        <Step key="done">
          <h3>Two-step verification is on</h3>
          <p>Next time you sign in, Lineboard will ask for a code from this app. For your security, all your other devices were signed out.</p>
          <Actions>
            <Btn label="Done" cls="primary" onClick={ctl.close} />
          </Actions>
        </Step>
      );
    case 'scan':
      return (
        <Step key="scan">
          <h3>Set up an authenticator app</h3>
          <ol className="enc-list">
            <li>Open your authenticator app and add an account.</li>
            <li>Scan this QR code, or enter the setup key by hand.</li>
            <li>Type the 6-digit code it shows.</li>
          </ol>
          <div className="mfa-qr">
            <img src={step.qr} alt="QR code for your authenticator app" width={180} height={180} />
          </div>
          <div className="mfa-secret-row">
            <code className="mfa-secret">{step.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <Btn
              label="Copy key"
              onClick={() =>
                void navigator.clipboard?.writeText(step.secret).then(
                  () => toast('Setup key copied.'),
                  () => toast('Copy it by hand.', 'error'),
                )
              }
            />
          </div>
          <StepForm
            onSubmit={() => {
              const problem = codeProblem(code);
              if (problem) return a.setErr(problem);
              void a.run('Checking...', async () => {
                await account.verifyCode(step.factorId, code);
                state.added = true;
                setStep({ k: 'done' });
              });
            }}
          >
            <Field label="6-digit code">
              <CodeInput value={code} set={setCode} />
            </Field>
            <ErrorLine a={a} />
            <Actions>
              <Btn label="Cancel" onClick={ctl.close} />
              <Btn label="Turn on" cls="primary" a={a} busy="Checking..." submit />
            </Actions>
          </StepForm>
        </Step>
      );
  }
}

// ----------------------------- second step after sign-in -----------------------------

/** Asks for a code from the authenticator app; `done` runs once the session reached the second level. */
export function SecondStepScreen({ account, factors, signOut, done }: { account: AccountSecurity; factors: Factor[]; signOut: () => void; done: () => void }) {
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState(factors[0]?.id ?? '');
  const a = useAction();
  const go = (value: string) => {
    const problem = codeProblem(value);
    if (problem) return a.setErr(problem);
    if (!factorId) return a.setErr('No authenticator found for this account.');
    if (a.pending) return;
    void a.run('Checking...', async () => {
      await account.verifyCode(factorId, value);
      done();
    });
  };
  return (
    <div className="auth-screen">
      <div className="auth-card unlock-card">
        <Step>
          <CardHead title="Two-step verification." text="Enter the 6-digit code from your authenticator app." />
          <StepForm className="auth-form" onSubmit={() => go(code)}>
            {factors.length > 1 && (
              <label>
                Authenticator
                <select className="dlg-input" aria-label="Authenticator" value={factorId} onChange={(e) => setFactorId(e.target.value)}>
                  {factors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.friendly_name || 'Authenticator app'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Code
              <CodeInput
                value={code}
                label="Authentication code"
                set={(v) => {
                  setCode(v);
                  if (/^\d{6}$/.test(cleanCode(v))) go(v);
                }}
              />
            </label>
            <ErrorLine a={a} />
            <Btn label="Verify" cls="primary wide" a={a} busy="Checking..." submit />
          </StepForm>
          <p className="muted text-small">Lost your authenticator? Use another device or app you added as a backup. Otherwise contact the operator of this Lineboard server.</p>
          <div className="unlock-links">
            <button className="link" type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </Step>
      </div>
    </div>
  );
}
