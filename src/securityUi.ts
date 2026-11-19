import type { Factor } from '@supabase/supabase-js';
import { MIN_PASSWORD } from './auth';
import { MAX_PASSWORD } from './limits';
import { AccountError, describeDevice, passkeysSupported, type AccountSecurity, type DeviceSession } from './account';
import { Captcha } from './captcha';
import { logo } from './brand';
import { actions, busy, button, check, errorLine, field, passInput, StepDialog } from './encryptionUi';
import { dialog, h, toast } from './util';

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

function codeInput() {
  return h('input', {
    type: 'text',
    class: 'dlg-input code-input',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    pattern: '[0-9 ]*',
    maxlength: '7',
    placeholder: '123456',
    'aria-label': '6-digit code',
  }) as HTMLInputElement;
}

/** replaceChildren that skips nulls. */
const put = (el: HTMLElement, ...items: (Node | null)[]) => el.replaceChildren(...items.filter((x): x is Node => !!x));

const cleanCode = (v: string) => v.replace(/\s/g, '');
const codeProblem = (v: string) => (/^\d{6}$/.test(cleanCode(v)) ? null : 'Enter the 6-digit code from your authenticator app.');

// ----------------------------- settings pane -----------------------------

export class SecurityPane {
  readonly el = h('div', { class: 'pane-stack' });
  private passwordCard = h('div', { class: 'set-card' });
  private mfaCard = h('div', { class: 'set-card' });
  private passkeyCard = h('div', { class: 'set-card' });
  private devicesCard = h('div', { class: 'set-card' });

  constructor(
    private account: AccountSecurity,
    private email: string | null,
  ) {
    this.el.append(this.passwordCard, this.mfaCard, this.passkeyCard, this.devicesCard);
    this.renderPassword();
  }

  /** Reload everything from the server (when the section is opened). */
  refresh() {
    void this.renderMfa();
    void this.renderPasskeys();
    void this.renderDevices();
  }

  private loading(card: HTMLElement, title: string) {
    card.replaceChildren(h('h4', {}, title), h('p', { class: 'muted' }, 'Loading...'));
  }

  private failed(card: HTMLElement, title: string, e: unknown) {
    card.replaceChildren(h('h4', {}, title), h('p', { class: 'enc-error' }, (e as Error).message));
  }

  private btn(text: string, onClick: () => void, cls = '') {
    const b = h('button', { class: 'btn ' + cls, type: 'button' }, text);
    b.addEventListener('click', onClick);
    return b;
  }

  // ----- password -----

  private renderPassword() {
    this.passwordCard.replaceChildren(
      h('h4', {}, 'Password'),
      h('p', { class: 'muted' }, 'Changing your password signs you out on every other device.'),
      h('div', { class: 'set-buttons' }, this.btn('Change password', () => void changePasswordDialog(this.account, this.email))),
    );
  }

  // ----- two-step verification -----

  private async renderMfa() {
    const card = this.mfaCard;
    this.loading(card, 'Two-step verification');
    try {
      const list = await this.account.authenticators();
      const rows = list.map((f) => {
        const remove = this.btn('Remove', async () => {
          const last = list.length === 1;
          const ok = await dialog({
            title: 'Remove this authenticator?',
            message: last
              ? 'This is your only authenticator, so two-step verification will be turned off. Signing in will need only your password or passkey.'
              : `"${f.friendly_name || 'Authenticator app'}" will no longer be accepted for sign-in.`,
            ok: 'Remove',
            danger: true,
          });
          if (!ok || !(await confirmItsYou(this.account, this.email))) return;
          try {
            await this.account.removeAuthenticator(f.id);
            toast(last ? 'Two-step verification is off.' : 'Authenticator removed.');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          void this.renderMfa();
        });
        return h(
          'li',
          { class: 'item-row' },
          h('div', { class: 'item-main' }, h('b', {}, f.friendly_name || 'Authenticator app'), h('small', { class: 'muted' }, `Added ${dateFmt.format(new Date(f.created_at))}`)),
          remove,
        );
      });
      const add = this.btn(list.length ? 'Add another authenticator' : 'Set up authenticator app', async () => {
        if (!(await confirmItsYou(this.account, this.email))) return;
        if (await addAuthenticatorDialog(this.account, list.length)) void this.renderMfa();
        void this.renderDevices();
      }, list.length ? '' : 'primary');
      put(
        card,
        h('h4', {}, 'Two-step verification'),
        h(
          'div',
          { class: 'set-switch' },
          h(
            'div',
            {},
            h('div', { class: 'set-label' }, 'Authenticator app'),
            h(
              'small',
              { class: 'muted' },
              list.length
                ? 'Signing in asks for a code from your authenticator app as well as your password or passkey.'
                : 'Ask for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy...) whenever you sign in.',
            ),
          ),
          h('span', { class: 'pill ' + (list.length ? 'on' : '') }, list.length ? 'On' : 'Off'),
        ),
        list.length ? h('ul', { class: 'item-list' }, ...rows) : null,
        list.length === 1 ? h('small', { class: 'muted' }, 'Tip: add the same account to a second phone or password manager as a backup in case you lose this one.') : null,
        h('div', { class: 'set-buttons' }, add),
      );
    } catch (e) {
      this.failed(card, 'Two-step verification', e);
    }
  }

  // ----- passkeys -----

  private async renderPasskeys() {
    const card = this.passkeyCard;
    const intro = h('p', { class: 'muted' }, 'Sign in with your fingerprint, face or device PIN instead of typing a password. Passkeys cannot be phished or reused.');
    if (!passkeysSupported()) {
      card.replaceChildren(h('h4', {}, 'Passkeys'), intro, h('p', { class: 'muted' }, 'This browser does not support passkeys.'));
      return;
    }
    this.loading(card, 'Passkeys');
    try {
      const list = await this.account.passkeys();
      const rows = list.map((p) => {
        const name = p.friendly_name || 'Passkey';
        const rename = this.btn('Rename', async () => {
          const next = await dialog({ title: 'Rename passkey', input: name, ok: 'Rename' });
          if (next === null) return;
          try {
            await this.account.renamePasskey(p.id, next.trim() || 'Passkey');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          void this.renderPasskeys();
        });
        const remove = this.btn('Remove', async () => {
          const ok = await dialog({
            title: 'Remove this passkey?',
            message: `"${name}" will no longer sign you in. Also delete it from the device or password manager that holds it.`,
            ok: 'Remove',
            danger: true,
          });
          if (!ok || !(await confirmItsYou(this.account, this.email))) return;
          try {
            await this.account.removePasskey(p.id);
            toast('Passkey removed.');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          void this.renderPasskeys();
        });
        return h(
          'li',
          { class: 'item-row' },
          h('div', { class: 'item-main' }, h('b', {}, name), h('small', { class: 'muted' }, `Added ${dateFmt.format(new Date(p.created_at))} · last used ${ago(p.last_used_at)}`)),
          h('div', { class: 'item-actions' }, rename, remove),
        );
      });
      const add = this.btn('Add a passkey', async () => {
        if (!(await confirmItsYou(this.account, this.email))) return;
        const guess = navigator.userAgent ? describeDevice(navigator.userAgent) : 'Passkey';
        const name = await dialog({ title: 'Add a passkey', message: 'Give it a name you will recognise, then follow your browser’s prompt.', input: guess, ok: 'Continue' });
        if (name === null) return;
        try {
          await this.account.addPasskey(name.trim());
          toast('Passkey added. You can now sign in with it.');
        } catch (e) {
          const msg = (e as Error).message;
          if (!/abort|cancel|not allowed/i.test(msg)) toast(msg, 'error');
        }
        void this.renderPasskeys();
      });
      put(card, h('h4', {}, 'Passkeys'), intro, list.length ? h('ul', { class: 'item-list' }, ...rows) : null, h('div', { class: 'set-buttons' }, add));
    } catch (e) {
      card.replaceChildren(
        h('h4', {}, 'Passkeys'),
        intro,
        h('p', { class: 'muted' }, 'Passkeys are not turned on for this Lineboard server yet. ' + (e instanceof AccountError && e.code ? '' : `(${(e as Error).message})`)),
      );
    }
  }

  // ----- devices -----

  private async renderDevices() {
    const card = this.devicesCard;
    this.loading(card, 'Signed-in devices');
    let sessions: DeviceSession[];
    try {
      sessions = await this.account.listSessions();
    } catch (e) {
      this.failed(card, 'Signed-in devices', e);
      return;
    }
    const rows = sessions.map((s) => {
      const name = describeDevice(s.user_agent);
      const meta = [s.is_current ? 'This device' : `Active ${ago(s.last_active)}`, `signed in ${dateFmt.format(new Date(s.created_at))}`, s.ip].filter(Boolean).join(' · ');
      const out = s.is_current
        ? h('span', { class: 'pill on' }, 'This device')
        : this.btn('Sign out', async () => {
            const ok = await dialog({ title: `Sign out ${name}?`, message: 'That device loses access right away and has to sign in again.', ok: 'Sign out', danger: true });
            if (!ok) return;
            try {
              await this.account.revokeSession(s.id);
              toast(`${name} signed out.`);
            } catch (e) {
              toast((e as Error).message, 'error');
            }
            void this.renderDevices();
          });
      return h(
        'li',
        { class: 'item-row' + (s.is_current ? ' current' : '') },
        h('div', { class: 'item-main' }, h('b', {}, name), h('small', { class: 'muted' }, meta)),
        out,
      );
    });
    const others = sessions.filter((s) => !s.is_current).length;
    const all = this.btn('Sign out all other devices', async () => {
      const ok = await dialog({
        title: 'Sign out all other devices?',
        message: `${others === 1 ? '1 other device' : `${others} other devices`} will be signed out and lose access right away. This device stays signed in.`,
        ok: 'Sign out others',
        danger: true,
      });
      if (!ok) return;
      try {
        await this.account.signOutOthers();
        toast('Signed out of all other devices.');
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      void this.renderDevices();
    });
    all.toggleAttribute('disabled', others === 0);
    card.replaceChildren(
      h('h4', {}, 'Signed-in devices'),
      h('p', { class: 'muted' }, "Devices where you're signed in to " + (this.email ?? 'your account') + '. Sign out any you don’t recognise, then change your password.'),
      h('ul', { class: 'item-list' }, ...rows),
      h('div', { class: 'set-buttons' }, all),
    );
  }
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
  const steps = (needPassword ? 1 : 0) + (needCode && !account.codeRecent ? 1 : 0);
  const d = new StepDialog('confirm-dialog');
  let ok = false;
  const heading = (n: number) => h('h3', {}, steps > 1 ? `Confirm it’s you (step ${n} of 2)` : 'Confirm it’s you');

  const withPassword = () => {
    const pass = passInput('current-password', '', MAX_PASSWORD);
    const err = errorLine();
    const captcha = new Captcha();
    const go = button(
      'Confirm',
      'primary',
      () => {
        if (!pass.value) return err.set('Enter your password.');
        if (!email) return err.set('This account has no email address to check the password against.');
        void busy(go, 'Checking...', err, async () => {
          await account.verifyPassword(email, pass.value, await captcha.take());
          if (needCode && !account.codeRecent) return withCode(2);
          ok = true;
          d.close();
        });
      },
      'submit',
    );
    d.show(
      heading(1),
      h('p', {}, why + ' Enter your password to continue.'),
      h('form', { class: 'enc-form' }, field('Password', pass), captcha.el, err.el, actions(button('Cancel', '', () => d.close()), go)),
      h('small', { class: 'muted' }, 'Signed up with an email link or a passkey and never set a password? Set one first with Change password.'),
    );
  };

  const withCode = (n: number) => {
    const code = codeInput();
    const err = errorLine();
    const go = button(
      'Confirm',
      'primary',
      () => {
        const problem = codeProblem(code.value);
        if (problem) return err.set(problem);
        void busy(go, 'Checking...', err, async () => {
          await account.confirmWithCode(factors[0].id, code.value);
          ok = true;
          d.close();
        });
      },
      'submit',
    );
    d.show(
      heading(n),
      h('p', {}, (n > 1 ? 'Two-step verification is on, so a code is needed as well. ' : why + ' ') + 'Enter the 6-digit code from your authenticator app.'),
      h('form', { class: 'enc-form' }, field('6-digit code', code), err.el, actions(button('Cancel', '', () => d.close()), go)),
    );
    code.focus();
  };

  if (needPassword) withPassword();
  else withCode(1);
  await d.closed;
  return ok;
}

export async function changePasswordDialog(account: AccountSecurity, email: string | null) {
  const d = new StepDialog();
  const current = passInput('current-password', '', MAX_PASSWORD);
  const a = passInput('new-password', '', MAX_PASSWORD);
  const b = passInput('new-password', '', MAX_PASSWORD);
  const others = check('Sign out all other devices', true);
  const code = codeInput();
  code.setAttribute('aria-label', 'Confirmation code from your email');
  const codeField = field('Confirmation code from your email', code);
  codeField.hidden = true;
  const currentField = field('Current password', current);
  const err = errorLine();
  const captcha = new Captcha();
  // Two-step verification on: a code from the authenticator app is needed as well, whichever way
  // the current password is proven (otherwise a stolen password could change the password).
  const factors = await account.authenticators().catch(() => null);
  if (!factors) return toast('Could not check your sign-in methods. Try again.', 'error');
  const totp = codeInput();
  totp.setAttribute('aria-label', '6-digit code from your authenticator app');
  const totpField = field('6-digit code from your authenticator app', totp);
  totpField.hidden = !factors.length;
  /** Accounts without a password (email link / passkey sign-up) confirm with an emailed code instead. */
  let byEmail = false;
  const noPassword = button('No password yet, or forgot it? Email me a code instead', 'link-btn', () => {
    void busy(noPassword, 'Sending...', err, async () => {
      await account.sendPasswordCode();
      byEmail = true;
      currentField.hidden = true;
      noPassword.hidden = true;
      codeField.hidden = false;
      code.focus();
      err.set('');
      toast(email ? `Code sent to ${email}.` : 'Code sent.');
    });
  });
  const go = button(
    'Change password',
    'primary',
    () => {
      if (!byEmail && !current.value) return err.set('Enter your current password.');
      if (a.value.length < MIN_PASSWORD) return err.set(`Use at least ${MIN_PASSWORD} characters.`);
      if (a.value.length > MAX_PASSWORD) return err.set(`Use at most ${MAX_PASSWORD} characters.`);
      if (a.value !== b.value) return err.set('The two new passwords do not match.');
      if (!codeField.hidden && !/^\d{6,10}$/.test(cleanCode(code.value))) return err.set('Enter the code from the email.');
      const totpProblem = factors.length ? codeProblem(totp.value) : null;
      if (totpProblem) return err.set(totpProblem);
      void busy(go, 'Saving...', err, async () => {
        if (factors.length) await account.confirmWithCode(factors[0].id, totp.value);
        try {
          if (!codeField.hidden) await account.changePassword(a.value, { nonce: cleanCode(code.value) }, { signOutOthers: others.input.checked });
          else await account.changePassword(a.value, { currentPassword: current.value, email: email ?? '', captchaToken: await captcha.take() }, { signOutOthers: others.input.checked });
        } catch (e) {
          // The project wants an emailed code too (old session and "secure password change" on).
          if (e instanceof AccountError && e.code === 'reauthentication_needed') {
            byEmail = true;
            currentField.hidden = true;
            noPassword.hidden = true;
            codeField.hidden = false;
            code.focus();
          }
          throw e;
        }
        d.close();
        toast(others.input.checked ? 'Password changed. Other devices were signed out.' : 'Password changed.');
      });
    },
    'submit',
  );
  d.show(
    h('h3', {}, 'Change password'),
    h('p', {}, 'This is the password you sign in with. If you use end-to-end encryption, your encryption passphrase does not change.'),
    h(
      'form',
      { class: 'enc-form' },
      currentField,
      noPassword,
      codeField,
      field('New password', a, `At least ${MIN_PASSWORD} characters.`),
      field('Type the new password again', b),
      totpField,
      others.el,
      captcha.el,
      err.el,
      actions(button('Cancel', '', () => d.close()), go),
    ),
  );
  current.focus();
  await d.closed;
}

/** Walk through adding an authenticator app. Resolves true when one was added. */
export async function addAuthenticatorDialog(account: AccountSecurity, existing: number): Promise<boolean> {
  const d = new StepDialog('mfa-dialog');
  let factorId: string | null = null;
  let added = false;
  d.closed.then(() => {
    if (factorId && !added) void account.cancelAuthenticator(factorId).catch(() => {});
  });

  d.show(h('h3', {}, 'Set up an authenticator app'), h('p', {}, 'Getting a code...'));
  try {
    const name = existing ? `Authenticator ${existing + 1}` : 'Authenticator app';
    const started = await account.startAuthenticator(name);
    factorId = started.factorId;
    const code = codeInput();
    const err = errorLine();
    const secret = h('code', { class: 'mfa-secret' }, started.secret.replace(/(.{4})/g, '$1 ').trim());
    const copy = button('Copy key', '', () => {
      navigator.clipboard?.writeText(started.secret).then(() => toast('Setup key copied.'), () => toast('Copy it by hand.', 'error'));
    });
    const go = button(
      'Turn on',
      'primary',
      () => {
        const problem = codeProblem(code.value);
        if (problem) return err.set(problem);
        void busy(go, 'Checking...', err, async () => {
          await account.verifyCode(started.factorId, code.value);
          added = true;
          d.show(
            h('h3', {}, 'Two-step verification is on'),
            h('p', {}, 'Next time you sign in, Lineboard will ask for a code from this app. For your security, all your other devices were signed out.'),
            actions(button('Done', 'primary', () => d.close())),
          );
        });
      },
      'submit',
    );
    d.show(
      h('h3', {}, 'Set up an authenticator app'),
      h('ol', { class: 'enc-list' }, h('li', {}, 'Open your authenticator app and add an account.'), h('li', {}, 'Scan this QR code, or enter the setup key by hand.'), h('li', {}, 'Type the 6-digit code it shows.')),
      h('div', { class: 'mfa-qr' }, h('img', { src: started.qr, alt: 'QR code for your authenticator app', width: '180', height: '180' })),
      h('div', { class: 'mfa-secret-row' }, secret, copy),
      h('form', { class: 'enc-form' }, field('6-digit code', code), err.el, actions(button('Cancel', '', () => d.close()), go)),
    );
    code.focus();
  } catch (e) {
    d.show(h('h3', {}, 'Could not start'), h('p', {}, (e as Error).message), actions(button('Close', '', () => d.close())));
  }
  await d.closed;
  return added;
}

// ----------------------------- second step after sign-in -----------------------------

/**
 * Asks for a code from the authenticator app. Resolves once the session reached the second level.
 */
export async function renderSecondStep(root: HTMLElement, account: AccountSecurity, signOut: () => void): Promise<void> {
  const factors = await account.authenticators().catch(() => []);
  return new Promise((resolve) => {
    const code = codeInput();
    code.setAttribute('aria-label', 'Authentication code');
    const choose =
      factors.length > 1
        ? (h('select', { class: 'dlg-input', 'aria-label': 'Authenticator' }, ...factors.map((f) => h('option', { value: f.id }, f.friendly_name || 'Authenticator app'))) as HTMLSelectElement)
        : null;
    const err = errorLine();
    const go = button(
      'Verify',
      'primary wide',
      () => {
        const problem = codeProblem(code.value);
        if (problem) return err.set(problem);
        const factorId = choose?.value ?? factors[0]?.id;
        if (!factorId) return err.set('No authenticator found for this account.');
        void busy(go, 'Checking...', err, async () => {
          await account.verifyCode(factorId, code.value);
          resolve();
        });
      },
      'submit',
    );
    const out = h('button', { class: 'link', type: 'button' }, 'Sign out');
    out.addEventListener('click', signOut);
    code.addEventListener('input', () => {
      if (/^\d{6}$/.test(cleanCode(code.value))) go.click();
    });
    root.replaceChildren(
      h(
        'div',
        { class: 'auth-screen' },
        h(
          'div',
          { class: 'auth-card unlock-card' },
          h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')),
          h('h1', { class: 'auth-heading' }, 'Two-step verification.'),
          h('p', { class: 'tagline' }, 'Enter the 6-digit code from your authenticator app.'),
          h('form', { class: 'auth-form' }, choose ? h('label', {}, 'Authenticator', choose) : null, h('label', {}, 'Code', code), err.el, go),
          h('p', { class: 'muted text-small' }, 'Lost your authenticator? Use another device or app you added as a backup. Otherwise contact the operator of this Lineboard server.'),
          h('div', { class: 'unlock-links' }, out),
        ),
      ),
    );
    code.focus();
  });
}
