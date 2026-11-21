import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AccountError } from '../account';
import { WrongSecretError } from '../crypto/vault';
import { MAX_PASSPHRASE } from '../limits';
import { showOverlay } from './overlays';
import { PasswordInput } from './PasswordInput';

/**
 * Building blocks for the step-by-step dialogs and screens of encryption and account security:
 * a modal whose content changes step by step, form fields, and buttons that show progress.
 */

export interface StepCtl {
  close(): void;
  /** While false (keys being saved, notes being encrypted), Escape does not close the dialog. */
  setClosable(on: boolean): void;
}

/** Show a step-by-step modal; resolves when it closes. `render` draws its content (a component with the flow's state). */
export function openSteps(cls: string, render: (ctl: StepCtl) => ReactNode): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    showOverlay((close) => (
      <StepDialog
        cls={cls}
        render={render}
        done={() => {
          if (done) return;
          done = true;
          close();
          resolve();
        }}
      />
    ));
  });
}

function StepDialog({ cls, render, done }: { cls: string; render: (ctl: StepCtl) => ReactNode; done: () => void }) {
  const d = useRef<HTMLDialogElement>(null);
  const closable = useRef(true);
  const [ctl] = useState<StepCtl>(() => ({ close: done, setClosable: (on) => (closable.current = on) }));
  useLayoutEffect(() => {
    d.current?.showModal();
  }, []);
  return (
    <dialog
      ref={d}
      className={('modal small ' + cls).trim()}
      onCancel={(e) => {
        e.preventDefault();
        if (closable.current) done();
      }}
    >
      <div className="dlg enc-dlg">{render(ctl)}</div>
    </dialog>
  );
}

/** One step's content: when it appears, its first field (or its main button) takes the focus. */
export function Step({ children }: { children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    el.current?.querySelector<HTMLElement>('input:not([type=checkbox]), button.primary')?.focus();
  }, []);
  return (
    <div ref={el} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

/** A labelled field, with an optional hint under it. */
export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="enc-field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}

/**
 * A password or passphrase input (with the show / hide eye unless `plain`). A new one is limited to
 * `max` characters; an existing one is not, so a secret chosen before the limit existed can still
 * be typed in full.
 */
export function PassInput({
  value,
  set,
  autoComplete,
  max = MAX_PASSPHRASE,
  plain,
  ...rest
}: {
  value: string;
  set: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  max?: number;
  plain?: boolean;
  'aria-label'?: string;
  placeholder?: string;
}) {
  const props = {
    className: 'dlg-input',
    autoComplete,
    spellCheck: false,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value),
    ...(autoComplete === 'new-password' ? { maxLength: max } : {}),
    ...rest,
  };
  return plain ? <input type="password" {...props} /> : <PasswordInput {...props} />;
}

/** A 6-digit code from an authenticator app (or a longer one from an email). */
export function CodeInput({ value, set, label = '6-digit code' }: { value: string; set: (v: string) => void; label?: string }) {
  return (
    <input
      type="text"
      className="dlg-input code-input"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      maxLength={7}
      placeholder="123456"
      aria-label={label}
      value={value}
      onChange={(e) => set(e.target.value)}
    />
  );
}

export const cleanCode = (v: string) => v.replace(/\s/g, '');
export const codeProblem = (v: string) => (/^\d{6}$/.test(cleanCode(v)) ? null : 'Enter the 6-digit code from your authenticator app.');

export function Check({ text, on, set }: { text: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <label className="set-check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{text}</span>
    </label>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="dlg-actions">{children}</div>;
}

/** A form whose action runs from its submit button (or Enter in a field). */
export function StepForm({ className = 'enc-form', onSubmit, children }: { className?: string; onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className={className}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/**
 * An action's progress and error message. `run` shows the error (wrong passphrase etc.) instead of
 * throwing; while it runs, the button that started it shows `label` and waits.
 */
export function useAction() {
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (label: string, fn: () => Promise<void>) => {
    setPending(label);
    setErr('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setErr(e instanceof WrongSecretError || e instanceof AccountError ? e.message : 'Something went wrong: ' + (e as Error).message);
      console.error(e);
    } finally {
      if (alive.current) setPending(null);
    }
  };
  return { err, setErr, pending, run };
}
export type Action = ReturnType<typeof useAction>;

export function ErrorLine({ a }: { a: Action }) {
  return (
    <p className="enc-error" role="alert">
      {a.err}
    </p>
  );
}

/**
 * A button. With `busy` (the label shown while its action runs), it waits while that action runs.
 * `submit` makes it the form's submit button (the form's onSubmit runs the action).
 */
export function Btn({ label, cls = '', a, busy, submit, onClick, hidden }: { label: string; cls?: string; a?: Action; busy?: string; submit?: boolean; onClick?: () => void; hidden?: boolean }) {
  const waiting = !!a && !!busy && a.pending === busy;
  return (
    <button className={('btn ' + cls).trim()} type={submit ? 'submit' : 'button'} disabled={waiting} hidden={hidden} onClick={onClick}>
      {waiting ? busy : label}
    </button>
  );
}
