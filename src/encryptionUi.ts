import { AccountError } from './account';
import { logo } from './brand';
import { KeysChangedError, MIN_PASSPHRASE, WrongSecretError, type KeyVault } from './crypto/vault';
import { MAX_PASSPHRASE } from './limits';
import type { SupabaseStore } from './store/supabaseStore';
import { FORM_SENT, h, toast, withReveal } from './util';

/**
 * Screens and dialogs for end-to-end encryption: turning it on (with a recovery key), unlocking
 * on a device, recovering with the recovery key, changing the passphrase and turning it off.
 */

// ----------------------------- small building blocks -----------------------------

export function field(label: string, input: HTMLInputElement, help?: string) {
  // Password fields get the show / hide eye.
  return h('label', { class: 'enc-field' }, h('span', {}, label), input.type === 'password' ? withReveal(input) : input, help ? h('small', {}, help) : null);
}

/**
 * A password or passphrase field. A new one is limited to `max` characters; an existing one is not,
 * so a secret chosen before the limit existed can still be typed in full.
 */
export function passInput(autocomplete: 'current-password' | 'new-password', placeholder = '', max = MAX_PASSPHRASE) {
  return h('input', { type: 'password', class: 'dlg-input', autocomplete, placeholder, spellcheck: 'false', ...(autocomplete === 'new-password' ? { maxlength: String(max) } : {}) }) as HTMLInputElement;
}

export function check(text: string, checked = false) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  return { input, el: h('label', { class: 'set-check' }, input, h('span', {}, text)) };
}

export function errorLine() {
  const el = h('p', { class: 'enc-error', role: 'alert' });
  return {
    el,
    set(msg: string) {
      el.textContent = msg;
    },
  };
}

/** Validate a new passphrase pair; returns an error message or null. */
function passProblem(a: string, b: string): string | null {
  if (a.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  if (a !== b) return 'The two passphrases do not match.';
  return null;
}

/** A modal whose content is replaced step by step. Escape and backdrop clicks close it only when allowed. */
export class StepDialog {
  readonly dlg: HTMLDialogElement;
  private body: HTMLElement;
  closable = true;
  private done: () => void = () => {};
  readonly closed: Promise<void>;

  constructor(cls = '') {
    this.body = h('div', { class: 'dlg enc-dlg' });
    this.dlg = h('dialog', { class: 'modal small ' + cls }, this.body);
    this.dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (this.closable) this.close();
    });
    this.closed = new Promise((r) => (this.done = r));
    document.body.append(this.dlg);
    this.dlg.showModal();
  }

  show(...children: (Node | string | null)[]) {
    this.body.replaceChildren(...children.filter((c): c is Node | string => c !== null));
    this.body.querySelector<HTMLElement>('input:not([type=checkbox]), button.primary')?.focus();
  }

  close() {
    this.dlg.close();
    this.dlg.remove();
    this.done();
  }
}

export function actions(...btns: HTMLElement[]) {
  return h('div', { class: 'dlg-actions' }, ...btns);
}

export function button(text: string, cls: string, onClick: () => void, type: 'button' | 'submit' = 'button') {
  const b = h('button', { class: 'btn ' + cls, type }, text) as HTMLButtonElement;
  b.addEventListener('click', (e) => {
    if (type === 'submit') {
      e.preventDefault();
      // No native submit event follows, so tell the form's fields it was sent (passwords hide again).
      b.form?.dispatchEvent(new Event(FORM_SENT));
    }
    onClick();
  });
  return b;
}

/** Run `fn` with a button showing progress; shows the error (wrong passphrase etc.) instead of throwing. */
export async function busy(btn: HTMLButtonElement, label: string, err: ReturnType<typeof errorLine>, fn: () => Promise<void>) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  err.set('');
  try {
    await fn();
  } catch (e) {
    err.set(e instanceof WrongSecretError || e instanceof AccountError ? e.message : 'Something went wrong: ' + (e as Error).message);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function recoveryBox(key: string, email: string | null) {
  // One span per group (with its dash), so lines only break between groups.
  const groups = key.split('-');
  const code = h('code', { class: 'recovery-key', 'aria-label': 'Recovery key' }, ...groups.map((g, i) => h('span', {}, i < groups.length - 1 ? g + '-' : g)));
  const copy = button('Copy', '', () => {
    navigator.clipboard?.writeText(key).then(
      () => toast('Recovery key copied.'),
      () => toast('Could not copy; select the key and copy it by hand.', 'error'),
    );
  });
  const save = button('Download', '', () => {
    const text = [
      'Lineboard recovery key',
      '',
      key,
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
    const a = h('a', { href: url, download: 'lineboard-recovery-key.txt' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  return h('div', { class: 'recovery-box' }, code, h('div', { class: 'recovery-actions' }, copy, save));
}

/** Ask for the recovery key's last group, so nobody clicks past it without saving it. */
function confirmRecovery(dlgStep: StepDialog, key: string, email: string | null, intro: string, onConfirmed: () => void) {
  const last = key.split('-').pop()!;
  const typed = h('input', { type: 'text', class: 'dlg-input mono', maxlength: '4', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Last 4 characters of the recovery key' }) as HTMLInputElement;
  const saved = check('I saved my recovery key somewhere safe');
  const err = errorLine();
  const next = button('Continue', 'primary', () => {
    if (!saved.input.checked) return err.set('Save the recovery key first, then tick the box.');
    if (typed.value.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1') !== last) return err.set('Those are not the last 4 characters of your recovery key.');
    onConfirmed();
  });
  dlgStep.show(
    h('h3', {}, 'Save your recovery key'),
    h('p', {}, intro),
    recoveryBox(key, email),
    h('p', { class: 'enc-warn' }, 'This is the only time it is shown. Without it and your passphrase, nobody can unlock your notes.'),
    field('To confirm, type the last 4 characters', typed),
    saved.el,
    err.el,
    actions(next),
  );
}

// ----------------------------- turning encryption on -----------------------------

export interface EnableContext {
  vault: KeyVault;
  store: SupabaseStore;
  email: string | null;
  noteCount: number;
}

/** The full "turn on encryption" flow. Resolves true when encryption ended up on. */
export async function enableEncryption(c: EnableContext): Promise<boolean> {
  const d = new StepDialog('enc-wizard');
  let result = false;

  const intro = () => {
    const understand = check('I understand that if I lose both my passphrase and my recovery key, my notes are gone for good.');
    const err = errorLine();
    d.show(
      h('h3', {}, 'Turn on end-to-end encryption?'),
      h(
        'p',
        {},
        c.noteCount
          ? `All your existing notes (${c.noteCount === 1 ? '1 note' : `${c.noteCount} notes`}), their titles and your notebook names will be encrypted on this device and stored on the server only in encrypted form.`
          : 'Your notes, their titles and your notebook names will be encrypted on this device and stored on the server only in encrypted form.',
      ),
      h(
        'ul',
        { class: 'enc-list' },
        h('li', {}, 'You choose an encryption passphrase. It is separate from your login password and never leaves this device.'),
        h('li', {}, 'You get a recovery key, in case you forget the passphrase.'),
        h('li', {}, 'On each new device you will type the passphrase once to unlock your notes.'),
        h('li', {}, 'The server can still see when notes change and roughly how much ink they hold, but not what they say.'),
      ),
      h('p', { class: 'enc-warn' }, 'Nobody, including Lineboard, can reset your passphrase or read your notes for you.'),
      understand.el,
      err.el,
      actions(
        button('Cancel', '', () => d.close()),
        button('Continue', 'primary', () => {
          if (!understand.input.checked) return err.set('Tick the box to confirm you understand.');
          choosePass();
        }),
      ),
    );
  };

  const choosePass = () => {
    const a = passInput('new-password');
    const b = passInput('new-password');
    const remember = check('Keep this device unlocked', true);
    const err = errorLine();
    const go = button(
      'Create keys',
      'primary',
      () => {
        const problem = passProblem(a.value, b.value);
        if (problem) return err.set(problem);
        void busy(go, 'Creating keys...', err, async () => {
          const prepared = await c.vault.prepare(a.value);
          a.value = b.value = '';
          confirmRecovery(d, prepared.recoveryKey, c.email, 'If you ever forget your passphrase, this key is the only other way to unlock your notes.', () =>
            void encrypt(prepared.commit, remember.input.checked),
          );
        });
      },
      'submit',
    );
    d.show(
      h('h3', {}, 'Choose an encryption passphrase'),
      h('form', { class: 'enc-form' },
        field('Passphrase', a, `At least ${MIN_PASSPHRASE} characters. A few unrelated words is easy to remember and hard to guess.`),
        field('Type it again', b),
        remember.el,
        h('small', { class: 'muted' }, 'Untick on a shared device: you will then type the passphrase each time you open Lineboard.'),
        err.el,
        actions(button('Back', '', intro), go),
      ),
    );
  };

  let committed = false;
  const encrypt = async (commit: (remember: boolean) => Promise<void>, remember: boolean) => {
    d.closable = false;
    const bar = h('progress', { class: 'enc-progress', max: '1', value: '0' }) as HTMLProgressElement;
    const label = h('p', {}, 'Saving your keys...');
    d.show(h('h3', {}, 'Encrypting your notes'), label, bar, h('p', { class: 'muted' }, 'Keep this window open. If it is interrupted, Lineboard finishes the job next time you open it.'));
    try {
      if (!committed) await commit(remember);
      committed = true;
      await c.store.convertAll((done, total) => {
        bar.max = Math.max(1, total);
        bar.value = done;
        label.textContent = total ? `Encrypted ${done} of ${total} notes...` : 'Encrypting...';
      });
      await c.vault.setState('on');
      result = true;
      d.closable = true;
      d.show(
        h('h3', {}, 'Your notes are encrypted'),
        h('p', {}, 'From now on everything you write is encrypted on this device before it is saved.'),
        actions(button('Done', 'primary', () => d.close())),
      );
    } catch (e) {
      console.error(e);
      d.closable = true;
      if (e instanceof KeysChangedError) {
        // Another device's keys are in place: these were not saved, and trying again cannot help.
        result = false;
        d.show(h('h3', {}, 'Encryption was set up elsewhere'), h('p', {}, e.message), actions(button('Reload', 'primary', () => location.reload())));
        return;
      }
      result = committed;
      d.show(
        h('h3', {}, committed ? 'Encryption is not finished yet' : 'Encryption was not turned on'),
        h(
          'p',
          {},
          committed
            ? 'Some notes could not be encrypted right now (' + (e as Error).message + '). New writing is already encrypted, and Lineboard will finish the rest the next time you open it.'
            : 'Your keys could not be saved (' + (e as Error).message + '), so nothing changed. Check your connection and try again; your recovery key stays the same.',
        ),
        actions(button('Close', '', () => d.close()), button('Try again', 'primary', () => void encrypt(commit, remember))),
      );
    }
  };

  intro();
  await d.closed;
  return result;
}

// ----------------------------- turning encryption off -----------------------------

export async function disableEncryption(c: EnableContext): Promise<boolean> {
  const d = new StepDialog();
  let result = false;
  const pass = passInput('current-password');
  const err = errorLine();
  const go = button(
    'Turn off encryption',
    'danger',
    () => {
      void busy(go, 'Checking...', err, async () => {
        await c.vault.verifyPassphrase(pass.value);
        pass.value = '';
        await run();
      });
    },
    'submit',
  );
  const run = async () => {
    d.closable = false;
    const bar = h('progress', { class: 'enc-progress', max: '1', value: '0' }) as HTMLProgressElement;
    const label = h('p', {}, 'Decrypting...');
    d.show(h('h3', {}, 'Decrypting your notes'), label, bar, h('p', { class: 'muted' }, 'Keep this window open.'));
    try {
      await c.vault.setState('decrypting');
      await c.store.convertAll((done, total) => {
        bar.max = Math.max(1, total);
        bar.value = done;
        label.textContent = `Decrypted ${done} of ${total} notes...`;
      });
      await c.vault.setState('off');
      result = true;
      d.closable = true;
      d.show(h('h3', {}, 'Encryption is off'), h('p', {}, 'Your notes are stored on the server without end-to-end encryption again.'), actions(button('Done', 'primary', () => d.close())));
    } catch (e) {
      console.error(e);
      d.closable = true;
      d.show(
        h('h3', {}, 'Not finished yet'),
        h('p', {}, 'Some notes could not be decrypted right now (' + (e as Error).message + '). Lineboard will finish the rest the next time you open it.'),
        actions(button('Close', '', () => d.close()), button('Try again', 'primary', () => void run())),
      );
    }
  };
  d.show(
    h('h3', {}, 'Turn off encryption?'),
    h('p', {}, 'Your notes will be decrypted and stored on the server in readable form, as they were before. Enter your encryption passphrase to confirm.'),
    h('form', { class: 'enc-form' }, field('Encryption passphrase', pass), err.el, actions(button('Cancel', '', () => d.close()), go)),
  );
  await d.closed;
  return result;
}

// ----------------------------- managing keys -----------------------------

export async function changePassphrase(vault: KeyVault) {
  const d = new StepDialog();
  const cur = passInput('current-password');
  const a = passInput('new-password');
  const b = passInput('new-password');
  const err = errorLine();
  const go = button(
    'Change passphrase',
    'primary',
    () => {
      const problem = passProblem(a.value, b.value);
      if (problem) return err.set(problem);
      void busy(go, 'Saving...', err, async () => {
        await vault.changePassphrase({ passphrase: cur.value }, a.value);
        d.close();
        toast('Encryption passphrase changed. Use the new one on your other devices.');
      });
    },
    'submit',
  );
  d.show(
    h('h3', {}, 'Change encryption passphrase'),
    h('p', {}, 'Your notes stay as they are; only the lock on your key changes. Devices that are already unlocked stay unlocked.'),
    h('form', { class: 'enc-form' },
      field('Current passphrase', cur),
      field('New passphrase', a, `At least ${MIN_PASSPHRASE} characters.`),
      field('Type the new one again', b),
      err.el,
      actions(button('Cancel', '', () => d.close()), go),
    ),
  );
  await d.closed;
}

export async function replaceRecoveryKey(vault: KeyVault, email: string | null) {
  const d = new StepDialog();
  const pass = passInput('current-password');
  const err = errorLine();
  const go = button(
    'Create new key',
    'primary',
    () => {
      void busy(go, 'Creating...', err, async () => {
        const key = await vault.newRecoveryKey(pass.value);
        d.closable = false;
        confirmRecovery(d, key, email, 'Your old recovery key no longer works. This new one replaces it.', () => {
          d.close();
          toast('New recovery key saved.');
        });
      });
    },
    'submit',
  );
  d.show(
    h('h3', {}, 'Create a new recovery key'),
    h('p', {}, 'Do this if you lost your recovery key or think someone else has seen it. The old key stops working.'),
    h('form', { class: 'enc-form' }, field('Encryption passphrase', pass), err.el, actions(button('Cancel', '', () => d.close()), go)),
  );
  await d.closed;
}

// ----------------------------- unlock screen -----------------------------

export interface UnlockOptions {
  vault: KeyVault;
  store: SupabaseStore;
  email: string | null;
  signOut: () => void;
}

/**
 * Full-page "your notes are encrypted" screen. Resolves once the vault is unlocked, or once the
 * user chose to start over (encrypted notes deleted, encryption off).
 */
export function renderUnlock(root: HTMLElement, o: UnlockOptions): Promise<void> {
  return new Promise((resolve) => {
    const card = h('div', { class: 'auth-card unlock-card' });
    const signOut = h('button', { class: 'link', type: 'button' }, 'Sign out');
    signOut.addEventListener('click', () => o.signOut());
    root.replaceChildren(h('div', { class: 'auth-screen' }, card));

    const head = (title: string, text: string) => [
      h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')),
      h('h1', { class: 'auth-heading' }, title),
      h('p', { class: 'tagline' }, text),
    ];
    const foot = (...links: HTMLElement[]) => h('div', { class: 'unlock-links' }, ...links, signOut);
    const linkBtn = (text: string, fn: () => void) => {
      const b = h('button', { class: 'link', type: 'button' }, text);
      b.addEventListener('click', fn);
      return b;
    };

    const passphrase = () => {
      const pass = passInput('current-password');
      pass.setAttribute('aria-label', 'Encryption passphrase');
      const remember = check('Keep this device unlocked', true);
      const err = errorLine();
      const go = button('Unlock', 'primary wide', () => {
        if (!pass.value) return err.set('Enter your encryption passphrase.');
        void busy(go, 'Unlocking...', err, async () => {
          await o.vault.unlockWithPassphrase(pass.value, remember.input.checked);
          resolve();
        });
      }, 'submit');
      card.replaceChildren(
        ...head('Your notes are encrypted.', `Enter your encryption passphrase to unlock them${o.email ? ` for ${o.email}` : ''}. It is the one you chose when you turned on encryption, not your login password.`),
        h('form', { class: 'auth-form' }, h('label', {}, 'Encryption passphrase', pass), remember.el, err.el, go),
        foot(linkBtn('Forgot it? Use your recovery key', recovery)),
      );
      pass.focus();
    };

    const recovery = () => {
      const key = h('input', { type: 'text', class: 'mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' }) as HTMLInputElement;
      const a = passInput('new-password');
      const b = passInput('new-password');
      const remember = check('Keep this device unlocked', true);
      const err = errorLine();
      const go = button('Unlock and set passphrase', 'primary wide', () => {
        const problem = passProblem(a.value, b.value);
        if (problem) return err.set('New passphrase: ' + problem);
        void busy(go, 'Unlocking...', err, async () => {
          await o.vault.unlockWithRecoveryKey(key.value, remember.input.checked);
          await o.vault.changePassphrase({ recoveryKey: key.value }, a.value);
          toast('Unlocked. Your recovery key still works; keep it safe.');
          resolve();
        });
      }, 'submit');
      card.replaceChildren(
        ...head('Use your recovery key.', 'Enter the recovery key you saved when you turned on encryption, then choose a new passphrase.'),
        h('form', { class: 'auth-form' },
          h('label', {}, 'Recovery key', key),
          h('label', {}, 'New passphrase', a),
          h('label', {}, 'Type it again', b),
          remember.el,
          err.el,
          go,
        ),
        foot(linkBtn('Back to passphrase', passphrase), linkBtn('Lost both?', lostBoth)),
      );
      key.focus();
    };

    const lostBoth = () => {
      const confirmInput = h('input', { type: 'text', autocomplete: 'off', placeholder: 'DELETE' }) as HTMLInputElement;
      const err = errorLine();
      const go = button('Delete my notes and start over', 'danger wide', () => {
        if (confirmInput.value.trim() !== 'DELETE') return err.set('Type DELETE to confirm.');
        void busy(go, 'Deleting...', err, async () => {
          await o.store.deleteEverything();
          await o.vault.removeKeys();
          toast('Encrypted notes deleted. You are starting with an empty notebook.');
          resolve();
        });
      }, 'submit');
      card.replaceChildren(
        ...head('Lost your passphrase and recovery key?', 'Without one of them your encrypted notes cannot be unlocked by anyone, including Lineboard. If you might still find either, stop here and keep looking.'),
        h('p', { class: 'enc-warn' }, 'Starting over permanently deletes every note and notebook in this account. Encryption is turned off; you can turn it on again in Settings.'),
        h('form', { class: 'auth-form' }, h('label', {}, 'Type DELETE to confirm', confirmInput), err.el, go),
        foot(linkBtn('Back', recovery)),
      );
    };

    passphrase();
  });
}
