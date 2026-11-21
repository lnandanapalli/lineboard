import { useRef, useState } from 'react';
import { KeysChangedError, MIN_PASSPHRASE, type KeyVault } from '../crypto/vault';
import type { SupabaseStore } from '../store/supabaseStore';
import { toast } from './Toast';
import { Logo } from './Logo';
import { Actions, Btn, Check, ErrorLine, Field, openSteps, PassInput, Step, StepForm, useAction, type StepCtl } from './steps';

/**
 * Screens and dialogs for end-to-end encryption: turning it on (with a recovery key), unlocking
 * on a device, recovering with the recovery key, changing the passphrase and turning it off.
 */

/** Validate a new passphrase pair; returns an error message or null. */
function passProblem(a: string, b: string): string | null {
  if (a.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (a !== b) return 'The two passphrases do not match.';
  return null;
}

function RecoveryBox({ value, email }: { value: string; email: string | null }) {
  // One span per group (with its dash), so lines only break between groups.
  const groups = value.split('-');
  const download = () => {
    const text = [
      'Lineboard recovery key',
      '',
      value,
      '',
      email ? `Account: ${email}` : '',
      `Created: ${new Date().toLocaleString()}`,
      '',
      'This key unlocks your encrypted notes if you forget your encryption passphrase.',
      'Keep it somewhere safe and private (a password manager, or printed). Anyone with it and',
      'access to your account can read your notes. Lineboard cannot recover it for you.',
    ]
      .filter((l, i, a) => l || a[i - 1])
      .join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lineboard-recovery-key.txt';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <div className="recovery-box">
      <code className="recovery-key" aria-label="Recovery key">
        {groups.map((g, i) => (
          <span key={i}>{i < groups.length - 1 ? g + '-' : g}</span>
        ))}
      </code>
      <div className="recovery-actions">
        <Btn
          label="Copy"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(
              () => toast('Recovery key copied.'),
              () => toast('Could not copy; select the key and copy it by hand.', 'error'),
            )
          }
        />
        <Btn label="Download" onClick={download} />
      </div>
    </div>
  );
}

/** Ask for the recovery key's last group, so nobody clicks past it without saving it. */
function ConfirmRecovery({ value, email, intro, onConfirmed }: { value: string; email: string | null; intro: string; onConfirmed: () => void }) {
  const last = value.split('-').pop()!;
  const [typed, setTyped] = useState('');
  const [saved, setSaved] = useState(false);
  const a = useAction();
  return (
    <Step>
      <h3>Save your recovery key</h3>
      <p>{intro}</p>
      <RecoveryBox value={value} email={email} />
      <p className="enc-warn">This is the only time it is shown. Without it and your passphrase, nobody can unlock your notes.</p>
      <Field label="To confirm, type the last 4 characters">
        <input type="text" className="dlg-input mono" maxLength={4} autoComplete="off" spellCheck={false} aria-label="Last 4 characters of the recovery key" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <Check text="I saved my recovery key somewhere safe" on={saved} set={setSaved} />
      <ErrorLine a={a} />
      <Actions>
        <Btn
          label="Continue"
          cls="primary"
          onClick={() => {
            if (!saved) return a.setErr('Save the recovery key first, then tick the box.');
            if (typed.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1') !== last) return a.setErr('Those are not the last 4 characters of your recovery key.');
            onConfirmed();
          }}
        />
      </Actions>
    </Step>
  );
}

/** A progress step (keys being saved, notes being converted). */
function Progress({ title, label, done, total, note }: { title: string; label: string; done: number; total: number; note: string }) {
  return (
    <Step>
      <h3>{title}</h3>
      <p>{label}</p>
      <progress className="enc-progress" max={total} value={done} />
      <p className="muted">{note}</p>
    </Step>
  );
}

/** A step with a message and its buttons. */
function Message({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <Step>
      <h3>{title}</h3>
      <p>{text}</p>
      <Actions>{children}</Actions>
    </Step>
  );
}

// ----------------------------- turning encryption on -----------------------------

export interface EnableContext {
  vault: KeyVault;
  store: SupabaseStore;
  email: string | null;
  noteCount: number;
}

type Commit = (remember: boolean) => Promise<void>;

/** The full "turn on encryption" flow. Resolves true when encryption ended up on. */
export async function enableEncryption(c: EnableContext): Promise<boolean> {
  const result = { on: false };
  await openSteps('enc-wizard', (ctl) => <EnableFlow c={c} ctl={ctl} result={result} />);
  return result.on;
}

type EnableStep =
  | { k: 'intro' }
  | { k: 'pass' }
  | { k: 'recovery'; key: string; commit: Commit; remember: boolean }
  | { k: 'progress'; label: string; done: number; total: number }
  | { k: 'done' }
  | { k: 'elsewhere'; msg: string }
  | { k: 'failed'; msg: string; commit: Commit; remember: boolean };

function EnableFlow({ c, ctl, result }: { c: EnableContext; ctl: StepCtl; result: { on: boolean } }) {
  const [step, setStep] = useState<EnableStep>({ k: 'intro' });
  const committed = useRef(false);
  const encrypt = async (commit: Commit, remember: boolean) => {
    ctl.setClosable(false);
    setStep({ k: 'progress', label: 'Saving your keys...', done: 0, total: 1 });
    try {
      if (!committed.current) await commit(remember);
      committed.current = true;
      await c.store.convertAll((done, total) => setStep({ k: 'progress', label: total ? `Encrypted ${done} of ${total} notes...` : 'Encrypting...', done, total: Math.max(1, total) }));
      await c.vault.setState('on');
      result.on = true;
      ctl.setClosable(true);
      setStep({ k: 'done' });
    } catch (e) {
      console.error(e);
      ctl.setClosable(true);
      if (e instanceof KeysChangedError) {
        // Another device's keys are in place: these were not saved, and trying again cannot help.
        result.on = false;
        setStep({ k: 'elsewhere', msg: e.message });
        return;
      }
      result.on = committed.current;
      setStep({ k: 'failed', msg: (e as Error).message, commit, remember });
    }
  };
  switch (step.k) {
    case 'intro':
      return <EnableIntro key="intro" noteCount={c.noteCount} cancel={ctl.close} next={() => setStep({ k: 'pass' })} />;
    case 'pass':
      return <ChoosePassphrase key="pass" vault={c.vault} back={() => setStep({ k: 'intro' })} next={(key, commit, remember) => setStep({ k: 'recovery', key, commit, remember })} />;
    case 'recovery':
      return <ConfirmRecovery key="recovery" value={step.key} email={c.email} intro="If you ever forget your passphrase, this key is the only other way to unlock your notes." onConfirmed={() => void encrypt(step.commit, step.remember)} />;
    case 'progress':
      return <Progress key="progress" title="Encrypting your notes" label={step.label} done={step.done} total={step.total} note="Keep this window open. If it is interrupted, Lineboard finishes the job next time you open it." />;
    case 'done':
      return (
        <Message key="done" title="Your notes are encrypted" text="From now on everything you write is encrypted on this device before it is saved.">
          <Btn label="Done" cls="primary" onClick={ctl.close} />
        </Message>
      );
    case 'elsewhere':
      return (
        <Message key="elsewhere" title="Encryption was set up elsewhere" text={step.msg}>
          <Btn label="Reload" cls="primary" onClick={() => location.reload()} />
        </Message>
      );
    case 'failed':
      return (
        <Message
          key={'failed' + step.msg}
          title={committed.current ? 'Encryption is not finished yet' : 'Encryption was not turned on'}
          text={
            committed.current
              ? 'Some notes could not be encrypted right now (' + step.msg + '). New writing is already encrypted, and Lineboard will finish the rest the next time you open it.'
              : 'Your keys could not be saved (' + step.msg + '), so nothing changed. Check your connection and try again; your recovery key stays the same.'
          }
        >
          <Btn label="Close" onClick={ctl.close} />
          <Btn label="Try again" cls="primary" onClick={() => void encrypt(step.commit, step.remember)} />
        </Message>
      );
  }
}

function EnableIntro({ noteCount, cancel, next }: { noteCount: number; cancel: () => void; next: () => void }) {
  const [understand, setUnderstand] = useState(false);
  const a = useAction();
  return (
    <Step>
      <h3>Turn on end-to-end encryption?</h3>
      <p>
        {noteCount
          ? `All your existing notes (${noteCount === 1 ? '1 note' : `${noteCount} notes`}), their titles and your notebook names will be encrypted on this device and stored on the server only in encrypted form.`
          : 'Your notes, their titles and your notebook names will be encrypted on this device and stored on the server only in encrypted form.'}
      </p>
      <ul className="enc-list">
        <li>You choose an encryption passphrase. It is separate from your login password and never leaves this device.</li>
        <li>You get a recovery key, in case you forget the passphrase.</li>
        <li>On each new device you will type the passphrase once to unlock your notes.</li>
        <li>The server can still see when notes change and roughly how much ink they hold, but not what they say.</li>
      </ul>
      <p className="enc-warn">Nobody, including Lineboard, can reset your passphrase or read your notes for you.</p>
      <Check text="I understand that if I lose both my passphrase and my recovery key, my notes are gone for good." on={understand} set={setUnderstand} />
      <ErrorLine a={a} />
      <Actions>
        <Btn label="Cancel" onClick={cancel} />
        <Btn label="Continue" cls="primary" onClick={() => (understand ? next() : a.setErr('Tick the box to confirm you understand.'))} />
      </Actions>
    </Step>
  );
}

function ChoosePassphrase({ vault, back, next }: { vault: KeyVault; back: () => void; next: (key: string, commit: Commit, remember: boolean) => void }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [remember, setRemember] = useState(true);
  const a = useAction();
  const go = () => {
    const problem = passProblem(p1, p2);
    if (problem) return a.setErr(problem);
    void a.run('Creating keys...', async () => {
      const prepared = await vault.prepare(p1);
      next(prepared.recoveryKey, prepared.commit, remember);
    });
  };
  return (
    <Step>
      <h3>Choose an encryption passphrase</h3>
      <StepForm onSubmit={go}>
        <Field label="Passphrase" help={`At least ${MIN_PASSPHRASE} characters. A few unrelated words is easy to remember and hard to guess.`}>
          <PassInput autoComplete="new-password" value={p1} set={setP1} />
        </Field>
        <Field label="Type it again">
          <PassInput autoComplete="new-password" value={p2} set={setP2} />
        </Field>
        <Check text="Keep this device unlocked" on={remember} set={setRemember} />
        <small className="muted">Untick on a shared device: you will then type the passphrase each time you open Lineboard.</small>
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Back" onClick={back} />
          <Btn label="Create keys" cls="primary" a={a} busy="Creating keys..." submit />
        </Actions>
      </StepForm>
    </Step>
  );
}

// ----------------------------- turning encryption off -----------------------------

export async function disableEncryption(c: EnableContext): Promise<boolean> {
  const result = { on: false };
  await openSteps('', (ctl) => <DisableFlow c={c} ctl={ctl} result={result} />);
  return result.on;
}

type DisableStep = { k: 'ask' } | { k: 'progress'; label: string; done: number; total: number } | { k: 'done' } | { k: 'failed'; msg: string };

function DisableFlow({ c, ctl, result }: { c: EnableContext; ctl: StepCtl; result: { on: boolean } }) {
  const [step, setStep] = useState<DisableStep>({ k: 'ask' });
  const [pass, setPass] = useState('');
  const a = useAction();
  const run = async () => {
    ctl.setClosable(false);
    setStep({ k: 'progress', label: 'Decrypting...', done: 0, total: 1 });
    try {
      await c.vault.setState('decrypting');
      await c.store.convertAll((done, total) => setStep({ k: 'progress', label: `Decrypted ${done} of ${total} notes...`, done, total: Math.max(1, total) }));
      await c.vault.setState('off');
      result.on = true;
      ctl.setClosable(true);
      setStep({ k: 'done' });
    } catch (e) {
      console.error(e);
      ctl.setClosable(true);
      setStep({ k: 'failed', msg: (e as Error).message });
    }
  };
  switch (step.k) {
    case 'ask':
      return (
        <Step key="ask">
          <h3>Turn off encryption?</h3>
          <p>Your notes will be decrypted and stored on the server in readable form, as they were before. Enter your encryption passphrase to confirm.</p>
          <StepForm
            onSubmit={() =>
              void a.run('Checking...', async () => {
                await c.vault.verifyPassphrase(pass);
                setPass('');
                await run();
              })
            }
          >
            <Field label="Encryption passphrase">
              <PassInput autoComplete="current-password" value={pass} set={setPass} />
            </Field>
            <ErrorLine a={a} />
            <Actions>
              <Btn label="Cancel" onClick={ctl.close} />
              <Btn label="Turn off encryption" cls="danger" a={a} busy="Checking..." submit />
            </Actions>
          </StepForm>
        </Step>
      );
    case 'progress':
      return <Progress key="progress" title="Decrypting your notes" label={step.label} done={step.done} total={step.total} note="Keep this window open." />;
    case 'done':
      return (
        <Message key="done" title="Encryption is off" text="Your notes are stored on the server without end-to-end encryption again.">
          <Btn label="Done" cls="primary" onClick={ctl.close} />
        </Message>
      );
    case 'failed':
      return (
        <Message key={'failed' + step.msg} title="Not finished yet" text={'Some notes could not be decrypted right now (' + step.msg + '). Lineboard will finish the rest the next time you open it.'}>
          <Btn label="Close" onClick={ctl.close} />
          <Btn label="Try again" cls="primary" onClick={() => void run()} />
        </Message>
      );
  }
}

// ----------------------------- managing keys -----------------------------

export function changePassphrase(vault: KeyVault): Promise<void> {
  return openSteps('', (ctl) => <ChangePassphrase vault={vault} ctl={ctl} />);
}

function ChangePassphrase({ vault, ctl }: { vault: KeyVault; ctl: StepCtl }) {
  const [cur, setCur] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const a = useAction();
  const go = () => {
    const problem = passProblem(p1, p2);
    if (problem) return a.setErr(problem);
    void a.run('Saving...', async () => {
      await vault.changePassphrase({ passphrase: cur }, p1);
      ctl.close();
      toast('Encryption passphrase changed. Use the new one on your other devices.');
    });
  };
  return (
    <Step>
      <h3>Change encryption passphrase</h3>
      <p>Your notes stay as they are; only the lock on your key changes. Devices that are already unlocked stay unlocked.</p>
      <StepForm onSubmit={go}>
        <Field label="Current passphrase">
          <PassInput autoComplete="current-password" value={cur} set={setCur} />
        </Field>
        <Field label="New passphrase" help={`At least ${MIN_PASSPHRASE} characters.`}>
          <PassInput autoComplete="new-password" value={p1} set={setP1} />
        </Field>
        <Field label="Type the new one again">
          <PassInput autoComplete="new-password" value={p2} set={setP2} />
        </Field>
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Cancel" onClick={ctl.close} />
          <Btn label="Change passphrase" cls="primary" a={a} busy="Saving..." submit />
        </Actions>
      </StepForm>
    </Step>
  );
}

export function replaceRecoveryKey(vault: KeyVault, email: string | null): Promise<void> {
  return openSteps('', (ctl) => <ReplaceRecoveryKey vault={vault} email={email} ctl={ctl} />);
}

function ReplaceRecoveryKey({ vault, email, ctl }: { vault: KeyVault; email: string | null; ctl: StepCtl }) {
  const [pass, setPass] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const a = useAction();
  if (key)
    return (
      <ConfirmRecovery
        value={key}
        email={email}
        intro="Your old recovery key no longer works. This new one replaces it."
        onConfirmed={() => {
          ctl.close();
          toast('New recovery key saved.');
        }}
      />
    );
  return (
    <Step>
      <h3>Create a new recovery key</h3>
      <p>Do this if you lost your recovery key or think someone else has seen it. The old key stops working.</p>
      <StepForm
        onSubmit={() =>
          void a.run('Creating...', async () => {
            const k = await vault.newRecoveryKey(pass);
            ctl.setClosable(false);
            setKey(k);
          })
        }
      >
        <Field label="Encryption passphrase">
          <PassInput autoComplete="current-password" value={pass} set={setPass} />
        </Field>
        <ErrorLine a={a} />
        <Actions>
          <Btn label="Cancel" onClick={ctl.close} />
          <Btn label="Create new key" cls="primary" a={a} busy="Creating..." submit />
        </Actions>
      </StepForm>
    </Step>
  );
}

// ----------------------------- unlock screen -----------------------------

export interface UnlockOptions {
  vault: KeyVault;
  store: SupabaseStore;
  email: string | null;
  signOut: () => void;
}

/** The brand and heading of a full-page step (unlock, two-step verification). */
export function CardHead({ title, text }: { title: string; text: string }) {
  return (
    <>
      <div className="brand">
        <Logo />
        <span>Lineboard</span>
      </div>
      <h1 className="auth-heading">{title}</h1>
      <p className="tagline">{text}</p>
    </>
  );
}

const Link = ({ text, onClick }: { text: string; onClick: () => void }) => (
  <button className="link" type="button" onClick={onClick}>
    {text}
  </button>
);

/**
 * Full-page "your notes are encrypted" screen. `done` runs once the vault is unlocked, or once the
 * user chose to start over (encrypted notes deleted, encryption off).
 */
export function UnlockScreen({ o, done }: { o: UnlockOptions; done: () => void }) {
  const [view, setView] = useState<'passphrase' | 'recovery' | 'lost'>('passphrase');
  const foot = (links: React.ReactNode) => (
    <div className="unlock-links">
      {links}
      <Link text="Sign out" onClick={o.signOut} />
    </div>
  );
  return (
    <div className="auth-screen">
      <div className="auth-card unlock-card">
        {view === 'passphrase' && <UnlockPassphrase key="p" o={o} done={done} foot={foot(<Link text="Forgot it? Use your recovery key" onClick={() => setView('recovery')} />)} />}
        {view === 'recovery' && (
          <UnlockRecovery
            key="r"
            o={o}
            done={done}
            foot={foot(
              <>
                <Link text="Back to passphrase" onClick={() => setView('passphrase')} />
                <Link text="Lost both?" onClick={() => setView('lost')} />
              </>,
            )}
          />
        )}
        {view === 'lost' && <LostBoth key="l" o={o} done={done} foot={foot(<Link text="Back" onClick={() => setView('recovery')} />)} />}
      </div>
    </div>
  );
}

type UnlockView = { o: UnlockOptions; done: () => void; foot: React.ReactNode };

function UnlockPassphrase({ o, done, foot }: UnlockView) {
  const [pass, setPass] = useState('');
  const [remember, setRemember] = useState(true);
  const a = useAction();
  return (
    <Step>
      <CardHead title="Your notes are encrypted." text={`Enter your encryption passphrase to unlock them${o.email ? ` for ${o.email}` : ''}. It is the one you chose when you turned on encryption, not your login password.`} />
      <StepForm
        className="auth-form"
        onSubmit={() => {
          if (!pass) return a.setErr('Enter your encryption passphrase.');
          void a.run('Unlocking...', async () => {
            await o.vault.unlockWithPassphrase(pass, remember);
            done();
          });
        }}
      >
        <label>
          Encryption passphrase
          <PassInput plain autoComplete="current-password" aria-label="Encryption passphrase" value={pass} set={setPass} />
        </label>
        <Check text="Keep this device unlocked" on={remember} set={setRemember} />
        <ErrorLine a={a} />
        <Btn label="Unlock" cls="primary wide" a={a} busy="Unlocking..." submit />
      </StepForm>
      {foot}
    </Step>
  );
}

function UnlockRecovery({ o, done, foot }: UnlockView) {
  const [key, setKey] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [remember, setRemember] = useState(true);
  const a = useAction();
  return (
    <Step>
      <CardHead title="Use your recovery key." text="Enter the recovery key you saved when you turned on encryption, then choose a new passphrase." />
      <StepForm
        className="auth-form"
        onSubmit={() => {
          const problem = passProblem(p1, p2);
          if (problem) return a.setErr('New passphrase: ' + problem);
          void a.run('Unlocking...', async () => {
            await o.vault.unlockWithRecoveryKey(key, remember);
            await o.vault.changePassphrase({ recoveryKey: key }, p1);
            toast('Unlocked. Your recovery key still works; keep it safe.');
            done();
          });
        }}
      >
        <label>
          Recovery key
          <input type="text" className="mono" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label>
          New passphrase
          <PassInput plain autoComplete="new-password" value={p1} set={setP1} />
        </label>
        <label>
          Type it again
          <PassInput plain autoComplete="new-password" value={p2} set={setP2} />
        </label>
        <Check text="Keep this device unlocked" on={remember} set={setRemember} />
        <ErrorLine a={a} />
        <Btn label="Unlock and set passphrase" cls="primary wide" a={a} busy="Unlocking..." submit />
      </StepForm>
      {foot}
    </Step>
  );
}

function LostBoth({ o, done, foot }: UnlockView) {
  const [typed, setTyped] = useState('');
  const a = useAction();
  return (
    <>
      <CardHead title="Lost your passphrase and recovery key?" text="Without one of them your encrypted notes cannot be unlocked by anyone, including Lineboard. If you might still find either, stop here and keep looking." />
      <p className="enc-warn">Starting over permanently deletes every note and notebook in this account. Encryption is turned off; you can turn it on again in Settings.</p>
      <StepForm
        className="auth-form"
        onSubmit={() => {
          if (typed.trim() !== 'DELETE') return a.setErr('Type DELETE to confirm.');
          void a.run('Deleting...', async () => {
            await o.store.deleteEverything();
            await o.vault.removeKeys();
            toast('Encrypted notes deleted. You are starting with an empty notebook.');
            done();
          });
        }}
      >
        <label>
          Type DELETE to confirm
          <input type="text" autoComplete="off" placeholder="DELETE" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <ErrorLine a={a} />
        <Btn label="Delete my notes and start over" cls="danger wide" a={a} busy="Deleting..." submit />
      </StepForm>
      {foot}
    </>
  );
}
