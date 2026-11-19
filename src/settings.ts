import { PAGE_W } from './board';
import { changePassphrase, disableEncryption, enableEncryption, replaceRecoveryKey } from './encryptionUi';
import { icons } from './icons';
import { SupabaseStore } from './store/supabaseStore';
import type { AccountSecurity } from './account';
import { confirmItsYou, SecurityPane } from './securityUi';
import type { Store } from './store/store';
import type { AppUser, Paper, Settings } from './types';
import { dialog, h, toast } from './util';
import { isApple, shortcut } from './keys';
import { orientation } from './orientation';

type Section = 'account' | 'signin' | 'security' | 'writing' | 'stylus' | 'about';

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'account', label: 'Account', icon: icons.user },
  { id: 'signin', label: 'Sign-in & devices', icon: icons.lockAll },
  { id: 'security', label: 'Encryption', icon: icons.shield },
  { id: 'writing', label: 'Page & writing', icon: icons.free },
  { id: 'stylus', label: 'Stylus & palm', icon: icons.hand },
  { id: 'about', label: 'About', icon: icons.info },
];

export interface SettingsHost {
  user: AppUser;
  store: Store;
  settings: () => Settings;
  /** A setting changed: save it and apply it to the board. */
  changed: () => void;
  pendingSaves: () => number;
  noteCount: () => number;
  signOut?: () => Promise<void>;
  /** Signed in with an account: password, two-step verification, passkeys, devices. */
  account?: AccountSecurity;
  /** Guest mode: a "Sign in to save" button. */
  signInButton?: () => HTMLElement;
  /** Download every notebook, note, picture and setting as a zip. */
  exportData: () => Promise<void>;
  /** Every notebook and note as one Lineboard file (.lbd). */
  exportAll: () => Promise<void>;
  /** Import notes from a Lineboard file (.lbd) or a zip of them. */
  importNotes: () => void;
  /** Signed in: delete the account and everything in it. */
  deleteAccount?: () => Promise<void>;
  /** No account: delete everything kept in this browser. */
  deleteLocalData?: () => Promise<void>;
}

/** The settings window: a sidebar of sections (account, page, stylus, security, about). */
export class SettingsPanel {
  readonly dlg: HTMLDialogElement;
  private nav = new Map<Section, HTMLButtonElement>();
  private panes = new Map<Section, HTMLElement>();
  private shell!: HTMLElement;
  private contactReadout!: HTMLElement;
  private securityBody = h('div', { class: 'pane-stack' });
  private syncForm: () => void = () => {};
  private securityPane: SecurityPane | null = null;

  constructor(private host: SettingsHost) {
    const navList = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' });
    for (const s of SECTIONS) {
      const b = h('button', { class: 'settings-tab', type: 'button', 'data-section': s.id }) as HTMLButtonElement;
      b.innerHTML = `${s.icon}<span></span>`;
      b.querySelector('span')!.textContent = s.label;
      b.addEventListener('click', () => this.show(s.id, true));
      this.nav.set(s.id, b);
      navList.append(b);
    }

    const content = h('div', { class: 'settings-content' });
    const builders: Record<Section, () => HTMLElement[]> = {
      account: () => this.accountPane(),
      writing: () => this.writingPane(),
      stylus: () => this.stylusPane(),
      security: () => [this.securityBody],
      signin: () => [this.signinPane()],
      about: () => this.aboutPane(),
    };
    for (const s of SECTIONS) {
      const back = h('button', { class: 'icon-btn settings-back', type: 'button', 'aria-label': 'All settings', title: 'All settings' });
      back.innerHTML = icons.chevron;
      back.addEventListener('click', () => this.shell.classList.remove('pane-open'));
      const pane = h(
        'section',
        { class: 'settings-pane', 'data-section': s.id, 'aria-label': s.label, hidden: true },
        h('div', { class: 'pane-head' }, back, h('h3', {}, s.label)),
        ...builders[s.id](),
      );
      this.panes.set(s.id, pane);
      content.append(pane);
    }

    const close = h('button', { class: 'icon-btn settings-close', type: 'button', 'aria-label': 'Close settings', title: 'Close' });
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.dlg.close());
    const done = h('button', { class: 'btn primary', type: 'button' }, 'Done');
    done.addEventListener('click', () => this.dlg.close());

    this.shell = h(
      'div',
      { class: 'settings-shell' },
      h('div', { class: 'settings-side' }, h('h2', {}, 'Settings'), navList),
      h('div', { class: 'settings-main' }, content, h('div', { class: 'settings-foot' }, done)),
      close,
    );
    this.dlg = h('dialog', { class: 'modal settings-modal' }, this.shell);
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
    document.body.append(this.dlg);
    this.show('account', false);
  }

  open(section?: Section) {
    this.syncForm();
    this.renderSecurity();
    if (section) this.show(section, true);
    this.dlg.showModal();
  }

  close() {
    this.dlg.close();
  }

  destroy() {
    this.dlg.remove();
  }

  private show(s: Section, focusPane: boolean) {
    for (const [id, b] of this.nav) {
      b.classList.toggle('active', id === s);
      b.setAttribute('aria-current', id === s ? 'page' : 'false');
    }
    for (const [id, p] of this.panes) p.hidden = id !== s;
    // On narrow screens the section list and the section are separate views.
    if (focusPane) this.shell.classList.add('pane-open');
    if (s === 'security') this.renderSecurity();
    if (s === 'signin') this.securityPane?.refresh();
  }

  showContact(size: number, type: string, accepted: boolean) {
    const reason = accepted ? 'drawn' : 'ignored';
    this.contactReadout.textContent = `Last contact on page: ${size ? Math.round(size) + ' px' : 'size not reported'} (${type}, ${reason})`;
  }

  // ----------------------------- helpers -----------------------------

  private row(label: string, control: HTMLElement, help?: string) {
    return h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label), control, help ? h('small', {}, help) : null);
  }

  /** A labelled on/off switch row (the settings-screen standard, instead of a bare checkbox). */
  private toggle(label: string, help: string, get: () => boolean, set: (on: boolean) => void): HTMLElement {
    const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': label }) as HTMLButtonElement;
    sw.append(h('i', { class: 'knob' }));
    const paint = () => {
      const on = get();
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', String(on));
    };
    sw.addEventListener('click', () => {
      set(!get());
      paint();
      this.host.changed();
    });
    this.addSync(paint);
    return h('div', { class: 'set-switch' }, h('div', {}, h('div', { class: 'set-label' }, label), h('small', { class: 'muted' }, help)), sw);
  }

  private card(title: string | null, ...children: (Node | null)[]) {
    return h('div', { class: 'set-card' }, title ? h('h4', {}, title) : null, ...children);
  }

  // ----------------------------- account -----------------------------

  private accountPane(): HTMLElement[] {
    const { user, store, signOut, signInButton } = this.host;
    const account = h('div', { class: 'set-account' });
    if (signOut) {
      const out = h('button', { class: 'btn', type: 'button' }, 'Sign out');
      out.addEventListener('click', async () => {
        if (this.host.pendingSaves()) {
          const ok = await dialog({ title: 'Unsaved changes', message: 'Some strokes are still being saved. Sign out anyway?', ok: 'Sign out', danger: true });
          if (!ok) return;
        }
        await signOut();
      });
      const avatar = h('div', { class: 'avatar', 'aria-hidden': 'true' }, (user.email ?? '?').slice(0, 1).toUpperCase());
      account.append(h('div', { class: 'profile' }, avatar, h('div', {}, h('div', { class: 'muted text-small' }, 'Signed in as'), h('b', {}, user.email ?? ''))), out);
    } else if (signInButton) {
      account.append(
        h('span', {}, "You're trying Lineboard without an account. Notes are saved only in this browser. Sign in or create a free account to keep them and use them on other devices."),
        signInButton(),
      );
    } else {
      account.append(h('span', {}, 'Local mode. Configure Supabase to sync across devices.'));
    }
    const where = signOut
      ? 'Your notebooks sync to your account, so they are on every device you sign in to.'
      : 'Notes stay in this browser on this device.';
    // Your data: a copy of everything (portability), and erasing it.
    const exportBtn = h('button', { class: 'btn', type: 'button' }, 'Download my data') as HTMLButtonElement;
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      try {
        await this.host.exportData();
      } finally {
        exportBtn.disabled = false;
      }
    });
    const allBtn = h('button', { class: 'btn', type: 'button' }, 'Export all notes (.lbd)') as HTMLButtonElement;
    allBtn.addEventListener('click', () => void this.host.exportAll());
    const importBtn = h('button', { class: 'btn', type: 'button' }, 'Import notes') as HTMLButtonElement;
    importBtn.addEventListener('click', () => this.host.importNotes());
    const erase = this.host.deleteAccount ?? this.host.deleteLocalData;
    const eraseBtn = erase ? (h('button', { class: 'btn danger', type: 'button' }, this.host.deleteAccount ? 'Delete account' : 'Delete everything on this device') as HTMLButtonElement) : null;
    eraseBtn?.addEventListener('click', () => void erase!());
    const dataCard = this.card(
      'Your data',
      h('p', { class: 'muted' }, 'Download a copy of everything: your account details and settings, and all your notebooks, notes (with their version history) and pictures as a Lineboard file (.lbd) you can import again.'),
      h('div', { class: 'row-actions' }, exportBtn),
      h('p', { class: 'muted' }, 'Move notes between accounts or devices: export them as a Lineboard file (.lbd), then import it. Exporting all notes keeps their version history; a single note or notebook, exported from the Notes list to share, has only its current content.'),
      h('div', { class: 'row-actions' }, allBtn, importBtn),
      eraseBtn
        ? h(
            'p',
            { class: 'muted' },
            this.host.deleteAccount
              ? 'Deleting your account removes it and everything in it from our servers, permanently.'
              : 'Deleting removes every note and picture saved in this browser, permanently.',
          )
        : null,
      eraseBtn ? h('div', { class: 'row-actions' }, eraseBtn) : null,
    );
    return [
      this.card(null, account),
      this.card('Storage', h('p', { class: 'muted' }, where), h('p', { class: 'muted' }, store.mode === 'cloud' ? 'Changes save in the background and wait while you are offline.' : '')),
      dataCard,
    ];
  }

  // ----------------------------- sign-in & devices -----------------------------

  private signinPane(): HTMLElement {
    const { account, user, signInButton } = this.host;
    if (account) {
      this.securityPane = new SecurityPane(account, user.email);
      return this.securityPane.el;
    }
    return this.card(
      null,
      h('p', { class: 'muted' }, signInButton ? 'Sign in to manage your password, two-step verification, passkeys and signed-in devices.' : 'Local mode has no accounts, so there is nothing to sign in to.'),
      signInButton ? signInButton() : null,
    );
  }

  // ----------------------------- page & writing -----------------------------

  private writingPane(): HTMLElement[] {
    const s = this.host.settings;
    const stripVal = h('output');
    const strip = h('input', { type: 'range', min: '40', max: '220', step: '5' }) as HTMLInputElement;
    const updStrip = () => {
      const px = Math.round((Number(strip.value) * (document.querySelector('.canvas-area')?.clientWidth ?? PAGE_W)) / PAGE_W);
      stripVal.textContent = `${strip.value} (~ ${px} px on this screen)`;
    };
    strip.addEventListener('input', () => {
      s().stripHeight = Number(strip.value);
      updStrip();
      this.host.changed();
    });
    const paper = h(
      'select',
      { 'aria-label': 'Free whiteboard paper' },
      ...(
        [
          ['plain', 'Plain'],
          ['lines', 'Lined'],
          ['grid', 'Grid'],
          ['dots', 'Dots'],
        ] as const
      ).map(([v, l]) => h('option', { value: v }, l)),
    ) as HTMLSelectElement;
    paper.addEventListener('change', () => {
      s().paper = paper.value as Paper;
      this.host.changed();
    });
    const smooth = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Smoothing' }) as HTMLInputElement;
    const smoothVal = h('output');
    const smoothText = (v: number) => (v === 0 ? 'Off' : v < 0.2 ? 'Light' : v < 0.5 ? 'Medium' : v < 0.8 ? 'Strong' : 'Very strong');
    smooth.addEventListener('input', () => {
      s().smoothing = Number(smooth.value);
      smoothVal.textContent = smoothText(s().smoothing);
      this.host.changed();
    });
    const lines = this.toggle('Ruled lines', 'Show a line between strips.', () => s().showLines, (on) => (s().showLines = on));
    const side = h('select', {}, h('option', { value: 'left' }, 'Left (right-handed)'), h('option', { value: 'right' }, 'Right (left-handed)')) as HTMLSelectElement;
    side.addEventListener('change', () => {
      s().marginSide = side.value as 'left' | 'right';
      this.host.changed();
    });

    this.addSync(() => {
      strip.value = String(s().stripHeight);
      updStrip();
      side.value = s().marginSide;
      paper.value = s().paper;
      smooth.value = String(s().smoothing);
      smoothVal.textContent = smoothText(s().smoothing);
    });

    return [
      this.card(
        'Strips',
        this.row('Strip height', h('div', { class: 'range' }, strip, stripVal), 'Taller strips leave more room for big handwriting.'),
        this.row('Lock icons on the', side),
        lines,
      ),
      this.card('Free whiteboard', this.row('Paper', paper, 'The background of the free whiteboard (Mode menu → Free whiteboard).')),
      this.card(
        'Ink',
        this.row('Smoothing', h('div', { class: 'range' }, smooth, smoothVal), 'Steadies shaky lines as you write. Turn it down if strokes feel like they lag behind the pen.'),
      ),
      this.card(
        'Display',
        this.toggle(
          'Manual orientation',
          'Keep the layout fixed to this device even when it rotates, and turn it yourself with the rotate button in the toolbar. Saved on this device only.',
          () => orientation.manual,
          (on) => orientation.setManual(on),
        ),
      ),
      this.card(null, h('p', { class: 'muted' }, 'Choose Split, Strips, Multi-strip or Free whiteboard from the Mode menu in the toolbar.')),
    ];
  }

  // ----------------------------- stylus & palm -----------------------------

  private stylusPane(): HTMLElement[] {
    const s = this.host.settings;
    const thrVal = h('output');
    const thr = h('input', { type: 'range', min: '5', max: '150', step: '1' }) as HTMLInputElement;
    thr.addEventListener('input', () => {
      s().touchThreshold = Number(thr.value);
      thrVal.textContent = thr.value + ' px';
      this.host.changed();
    });

    let samples: number[] = [];
    const calOut = h('span', { class: 'cal-out' }, 'No samples yet.');
    const pad = h('div', { class: 'cal-pad' }, 'Write here with your stylus');
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
    });
    const sample = (e: PointerEvent) => {
      if (e.buttons === 0 && e.type === 'pointermove') return;
      samples.push(Math.max(e.width || 0, e.height || 0));
      calOut.textContent = `Stylus contact: up to ${Math.round(Math.max(...samples))} px over ${samples.length} samples.`;
    };
    pad.addEventListener('pointerdown', sample);
    pad.addEventListener('pointermove', sample);
    const useCal = h('button', { class: 'btn', type: 'button' }, 'Set limit from samples');
    useCal.addEventListener('click', () => {
      if (!samples.length) return toast('Write in the box with your stylus first.');
      const max = Math.max(...samples);
      if (max <= 1) return toast('This browser does not report contact size, so size filtering cannot help here. Strips still work.');
      const v = Math.min(150, Math.max(5, Math.ceil(max * 1.4 + 4)));
      s().touchThreshold = v;
      thr.value = String(v);
      thrVal.textContent = v + ' px';
      this.host.changed();
      toast(`Palm limit set to ${v} px.`);
    });
    const resetCal = h('button', { class: 'btn', type: 'button' }, 'Clear');
    resetCal.addEventListener('click', () => {
      samples = [];
      calOut.textContent = 'No samples yet.';
    });

    const penOnly = this.toggle(
      'Ignore fingers when a pen is used',
      'If an active pen is detected, finger touches never draw.',
      () => s().penOnlyWhenPenSeen,
      (on) => (s().penOnlyWhenPenSeen = on),
    );
    this.contactReadout = h('p', { class: 'readout' }, 'Last contact on page: none yet');

    this.addSync(() => {
      thr.value = String(s().touchThreshold);
      thrVal.textContent = s().touchThreshold + ' px';
    });

    return [
      this.card(
        'Palm rejection inside the unlocked strip',
        this.row('Ignore touches larger than', h('div', { class: 'range' }, thr, thrVal), 'Palms register as big contacts. Calibrate below for your stylus.'),
        h('div', { class: 'cal' }, pad, h('div', { class: 'cal-side' }, calOut, h('div', { class: 'cal-btns' }, useCal, resetCal))),
        this.contactReadout,
      ),
      this.card('Active pens', penOnly),
    ];
  }

  // ----------------------------- privacy & security -----------------------------

  private renderSecurity() {
    const body = this.securityBody;
    const store = this.host.store;
    const vault = store instanceof SupabaseStore ? store.vault : undefined;

    const sw = (on: boolean, disabled: boolean) => {
      const b = h('button', {
        class: 'switch' + (on ? ' on' : ''),
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': 'End-to-end encryption',
        disabled,
      }) as HTMLButtonElement;
      b.append(h('i', { class: 'knob' }));
      return b;
    };
    const header = (toggle: HTMLButtonElement, status: string) =>
      h(
        'div',
        { class: 'set-switch' },
        h('div', {}, h('div', { class: 'set-label' }, 'End-to-end encryption'), h('small', { class: 'muted enc-status' }, status)),
        toggle,
      );
    const details = this.card(
      'How it works',
      h(
        'ul',
        { class: 'enc-list' },
        h('li', {}, 'Your ink, note titles and notebook names are encrypted on your device with a key only you hold.'),
        h('li', {}, 'The key is protected by an encryption passphrase, separate from your login password, plus a recovery key.'),
        h('li', {}, 'The server still sees when notes change and how much is in them, but cannot read them.'),
        h('li', {}, 'If you lose both the passphrase and the recovery key, the notes cannot be recovered by anyone.'),
      ),
    );

    if (!vault) {
      const msg = this.host.signInButton
        ? 'Encryption is available with an account. Notes you make without one stay in this browser and are never uploaded.'
        : 'Local mode keeps notes only on this device; nothing is uploaded, so there is nothing to encrypt in transit.';
      body.replaceChildren(this.card(null, header(sw(false, true), msg), this.host.signInButton ? this.host.signInButton() : null), details);
      return;
    }
    if (!vault.supported) {
      body.replaceChildren(
        this.card(null, header(sw(false, true), 'Not available yet: this server’s database needs an update first. Its operator re-runs supabase/schema.sql.')),
        details,
      );
      return;
    }

    const state = vault.state;
    const on = vault.writeEncrypted;
    const status = {
      off: 'Off. Your notes are stored on the server without end-to-end encryption.',
      encrypting: 'Turning on: some notes are still being encrypted. This finishes the next time you open Lineboard.',
      on: 'On. Everything you write is encrypted on this device before it is saved.',
      decrypting: 'Turning off: some notes are still being decrypted.',
    }[state];
    const toggle = sw(on, state === 'decrypting');
    const ctx = { vault, store: store as SupabaseStore, email: this.host.user.email, noteCount: this.host.noteCount() };
    toggle.addEventListener('click', async () => {
      if (on) await disableEncryption(ctx);
      else {
        // Someone with an unlocked device must not be able to lock the owner out with their own passphrase.
        if (this.host.account && !(await confirmItsYou(this.host.account, this.host.user.email, 'Encryption changes who can read your notes.'))) return;
        await enableEncryption(ctx);
      }
      this.renderSecurity();
    });

    const parts: HTMLElement[] = [this.card(null, header(toggle, status))];
    if (on) {
      const change = h('button', { class: 'btn', type: 'button' }, 'Change passphrase');
      change.addEventListener('click', () => void changePassphrase(vault));
      const recovery = h('button', { class: 'btn', type: 'button' }, 'New recovery key');
      recovery.addEventListener('click', () => void replaceRecoveryKey(vault, this.host.user.email));
      const lock = h('button', { class: 'btn', type: 'button' }, 'Lock this device');
      lock.addEventListener('click', async () => {
        const ok = await dialog({
          title: 'Lock this device?',
          message: 'Lineboard forgets the key on this device. You will need your encryption passphrase to open your notes here again.',
          ok: 'Lock',
        });
        if (!ok) return;
        await vault.lock();
        location.reload();
      });
      parts.push(
        this.card(
          'Keys',
          h('p', { class: 'muted' }, 'Lost your recovery key, or think someone saw it? Make a new one; the old one stops working.'),
          h('div', { class: 'set-buttons' }, change, recovery, lock),
        ),
      );
    }
    parts.push(details);
    body.replaceChildren(...parts);
  }

  // ----------------------------- about -----------------------------

  private aboutPane(): HTMLElement[] {
    const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
    return [
      this.card(
        null,
        h('p', {}, 'Lineboard is a handwriting whiteboard for tablets without an active pen: write above the line, and rest your hand below it.'),
        h('p', { class: 'set-links' }, link('/home', 'About Lineboard'), ' · ', link('/terms', 'Terms of service'), ' · ', link('/privacy', 'Privacy policy'), ' · ', link('https://github.com/lnandanapalli/lineboard', 'Source code')),
      ),
      this.card(
        'Keyboard shortcuts',
        h(
          'dl',
          { class: 'shortcuts' },
          ...(
            [
              [['P'], 'Pen'],
              [['H'], 'Highlighter'],
              [['E'], 'Eraser'],
              [['S'], 'Shapes (nearly square snaps to square; Keep proportions in the palette forces it)'],
              [['T'], 'Text (tap to type; Escape finishes)'],
              [['V'], 'Select (lasso or rectangle): drag inside the selection to move it'],
              [['Delete'], 'Delete the selection'],
              [['Mod+Z'], 'Undo'],
              [isApple ? ['Mod+Shift+Z'] : ['Mod+Y', 'Mod+Shift+Z'], 'Redo'],
              [['Up', 'Down'], 'Previous / next strip'],
              [['PageUp', 'PageDown'], 'Scroll the page'],
              [['M'], 'Strips ↔ Multi-strip'],
              [['F'], 'Free whiteboard on / off'],
            ] as [string[], string][]
          ).flatMap(([combos, what]) => [
            h('dt', {}, ...combos.flatMap((c, i) => [i ? ' ' : null, h('kbd', {}, shortcut(c))])),
            h('dd', {}, what),
          ]),
        ),
      ),
    ];
  }

  private addSync(fn: () => void) {
    const prev = this.syncForm;
    this.syncForm = () => {
      prev();
      fn();
    };
  }
}
