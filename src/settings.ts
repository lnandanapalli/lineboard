import { PAGE_W } from './board';
import { changePassphrase, disableEncryption, enableEncryption, replaceRecoveryKey } from './encryptionUi';
import { icons } from './icons';
import { SupabaseStore } from './store/supabaseStore';
import type { AccountSecurity } from './account';
import { confirmItsYou, SecurityPane } from './securityUi';
import type { Store } from './store/store';
import { TRASH_DAYS, type AppUser, type Paper, type Settings } from './types';
import { dialog, h, toast } from './util';
import { isApple, shortcut } from './keys';
import { orientation } from './orientation';
import { avatar, MAX_NAME, type Profile } from './profile';
import { infoButton, infoHeading } from './menu';
import { setTheme, themeChoice, type ThemeChoice } from './theme';
import { IMAGE_TYPES } from './images';

/** What end-to-end encryption does, behind the ⓘ next to its switch. */
const ENC_INFO =
  'Your ink, note titles, notebook names, pictures and version history are encrypted on your device with a key only you hold. The key is protected by an encryption passphrase (separate from your login password) and a recovery key. The server still sees when notes change and how much is in them, but cannot read them. If you lose both the passphrase and the recovery key, the notes cannot be recovered by anyone.';

type Section = 'account' | 'data' | 'signin' | 'security' | 'writing' | 'stylus' | 'about';

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'account', label: 'Account', icon: icons.user },
  { id: 'data', label: 'Data controls', icon: icons.archive },
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
  /** What automatic palm detection has learned so far, in words. */
  palmStatus: () => string;
  /** The display name and picture (the picture as an object URL, or null). */
  profile: () => { profile: Profile; url: string | null };
  changeProfile: (change: { name?: string; picture?: File | null }) => Promise<void>;
  /** What is archived: notebooks (with how many notes) and notes in notebooks that are not. */
  archived: () => { notebooks: { id: string; name: string; notes: number }[]; notes: { id: string; title: string; notebook: string }[] };
  unarchive: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  deleteArchived: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  /** What is in the trash: deleted notebooks (with how many notes) and notes deleted on their own. */
  trash: () => { notebooks: { id: string; name: string; notes: number; deleted_at: string }[]; notes: { id: string; title: string; notebook: string; deleted_at: string }[] };
  restoreTrashed: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  /** Delete one item for good (asks first). */
  deleteTrashed: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  /** Delete everything in the trash for good (asks first). */
  emptyTrash: () => Promise<void>;
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
      data: () => this.dataPane(),
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
    this.renderProfile();
    this.renderSecurity();
    this.renderArchived();
    this.renderTrash();
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

  /** Repaint the palm detection status (it changes as strokes are learned from). */
  private refreshPalm: () => void = () => {};

  showContact(size: number, type: string, accepted: boolean) {
    this.refreshPalm();
    const reason = accepted ? 'drawn' : 'ignored';
    this.contactReadout.textContent = `Last contact on page: ${size ? Math.round(size) + ' px' : 'size not reported'} (${type}, ${reason})`;
  }

  // ----------------------------- helpers -----------------------------

  /**
   * A setting: its label (with an ⓘ for the explanation, if any) and its control. The ⓘ is kept
   * out of a <label>, which would otherwise name the button instead of the control; the control
   * is named directly.
   */
  private row(label: string, control: HTMLElement, help?: string) {
    const field = control.matches('input, select, textarea') ? control : control.querySelector<HTMLElement>('input, select, textarea');
    if (field && !field.hasAttribute('aria-label')) field.setAttribute('aria-label', label);
    return h('div', { class: 'set-row' }, h('span', { class: 'set-label with-info' }, label, help ? infoButton(label, help) : null), control);
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
    return h('div', { class: 'set-switch' }, h('div', { class: 'set-label with-info' }, label, infoButton(label, help)), sw);
  }

  /** "Your data": built with the account pane, shown in Data controls. */
  private dataCards: HTMLElement[] = [];

  private card(title: string | null, ...children: (Node | null)[]) {
    return h('div', { class: 'set-card' }, title ? h('h4', {}, title) : null, ...children);
  }

  /** A card whose heading has an ⓘ with what the card is about. */
  private infoCard(title: string, info: string, ...children: (Node | null)[]) {
    return h('div', { class: 'set-card' }, infoHeading('h4', title, info), ...children);
  }

  // ----------------------------- profile -----------------------------

  private profileBody = h('div', { class: 'profile-edit' });
  private profileCard = h('div', { class: 'set-card' });

  /** Name and picture: shown in the sidebar instead of the email. */
  private renderProfile() {
    const { profile, url } = this.host.profile();
    const name = h('input', { type: 'text', class: 'dlg-input', maxlength: String(MAX_NAME), placeholder: 'Your name', 'aria-label': 'Display name', autocomplete: 'name' }) as HTMLInputElement;
    name.value = profile.name;
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save name') as HTMLButtonElement;
    const busy = async (b: HTMLButtonElement, fn: () => Promise<void>) => {
      b.disabled = true;
      try {
        await fn();
        this.renderProfile();
      } catch (e) {
        toast((e as Error).message, 'error');
        b.disabled = false;
      }
    };
    save.addEventListener('click', () => void busy(save, async () => {
      await this.host.changeProfile({ name: name.value });
      toast('Name saved.');
    }));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
    });
    const file = h('input', { type: 'file', accept: IMAGE_TYPES, hidden: true }) as HTMLInputElement;
    const pick = h('button', { class: 'btn', type: 'button' }, profile.picture ? 'Change picture' : 'Add picture') as HTMLButtonElement;
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void busy(pick, () => this.host.changeProfile({ picture: f }));
    });
    const remove = profile.picture ? (h('button', { class: 'btn danger-text', type: 'button' }, 'Remove picture') as HTMLButtonElement) : null;
    remove?.addEventListener('click', () => void busy(remove, () => this.host.changeProfile({ picture: null })));
    this.profileBody.replaceChildren(
      h('div', { class: 'profile-row' }, avatar(profile, url, 64), h('div', { class: 'row-actions' }, pick, remove, file)),
      h('label', { class: 'field-label' }, 'Display name'),
      h('div', { class: 'profile-name' }, name, save),
    );
    this.profileCard.replaceChildren(
      infoHeading('h4', 'Profile', `Your name and picture are shown in the sidebar instead of your email. Up to ${MAX_NAME} characters; leave the name empty for none.${this.host.user.email ? ' They are stored with your account.' : ''}`),
      this.profileBody,
    );
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
      account.append(h('div', { class: 'profile' }, h('div', {}, h('div', { class: 'muted text-small' }, 'Signed in as'), h('b', {}, user.email ?? ''))), out);
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
    this.dataCards = [this.infoCard(
      'Your data',
      'Download my data: a copy of everything, your account details and settings, and all your notebooks, notes (with their version history) and pictures as a Lineboard file (.lbd) you can import again. Export and import move notes between accounts or devices; exporting all notes keeps their version history, while a single note or notebook exported from the Notes list to share has only its current content.',
      h('div', { class: 'row-actions' }, exportBtn, allBtn, importBtn),
    ), ...(eraseBtn
      ? [this.infoCard(
          this.host.deleteAccount ? 'Delete account' : 'Delete local data',
          this.host.deleteAccount
            ? 'Deleting your account removes it and everything in it from our servers, permanently. You are asked to confirm first.'
            : 'Deleting removes every note and picture saved in this browser, permanently. You are asked to confirm first.',
          h('div', { class: 'row-actions' }, eraseBtn),
        )]
      : [])];
    return [
      this.profileCard,
      this.card(null, account),
      this.infoCard('Storage', store.mode === 'cloud' ? 'Changes save in the background and wait while you are offline.' : 'Nothing leaves this device.', h('p', { class: 'muted' }, where)),
    ];
  }

  /** Data controls: what is archived, a copy of everything, moving notes, and erasing it all. */
  private dataPane(): HTMLElement[] {
    return [
      this.infoCard('Trash', `Deleted notes and notebooks wait here for ${TRASH_DAYS} days, then they are deleted for good. Restore one to put it back where it was.`, this.trashBody),
      this.infoCard('Archived', 'Archived notes and notebooks are hidden from the sidebar and search. They are kept, with their history, until you restore or delete them. Archive one from its ⋯ menu.', this.archivedBody),
      ...this.dataCards,
    ];
  }
  private trashBody = h('div', { class: 'archived-list trash-list' });

  /** List what is in the trash, each with Restore and Delete forever, and a way to empty it. */
  private renderTrash() {
    const { notebooks, notes } = this.host.trash();
    const left = (at: string) => {
      const days = Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - Date.parse(at)) / 86_400_000));
      return days <= 1 ? 'deleted for good within a day' : `deleted for good in ${days} days`;
    };
    const row = (kind: 'note' | 'notebook', id: string, name: string, sub: string) => {
      const restore = h('button', { class: 'btn', type: 'button', 'aria-label': `Restore "${name}"` }, 'Restore') as HTMLButtonElement;
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        await this.host.restoreTrashed(kind, id);
        this.renderTrash();
      });
      const del = h('button', { class: 'btn danger-text', type: 'button', 'aria-label': `Delete "${name}" forever` }, 'Delete forever') as HTMLButtonElement;
      del.addEventListener('click', async () => {
        await this.host.deleteTrashed(kind, id);
        this.renderTrash();
      });
      return h('li', {}, h('div', { class: 'archived-name' }, h('span', { class: 'archived-kind' }, kind === 'note' ? 'Note' : 'Notebook'), h('b', {}, name), h('small', {}, sub)), h('div', { class: 'row-actions' }, restore, del));
    };
    const items = [
      ...notebooks.map((b) => row('notebook', b.id, b.name, `${b.notes === 1 ? '1 note' : `${b.notes} notes`} · ${left(b.deleted_at)}`)),
      ...notes.map((n) => row('note', n.id, n.title || 'Untitled', `${n.notebook ? `from ${n.notebook} · ` : ''}${left(n.deleted_at)}`)),
    ];
    if (!items.length) return this.trashBody.replaceChildren(h('p', { class: 'muted' }, 'The trash is empty.'));
    const empty = h('button', { class: 'btn danger-text', type: 'button' }, 'Empty trash') as HTMLButtonElement;
    empty.addEventListener('click', async () => {
      await this.host.emptyTrash();
      this.renderTrash();
    });
    this.trashBody.replaceChildren(h('ul', { class: 'archived-items' }, ...items), h('div', { class: 'row-actions trash-empty' }, empty));
  }
  private archivedBody = h('div', { class: 'archived-list' });

  /** List what is archived, each with Restore and Delete. */
  private renderArchived() {
    const { notebooks, notes } = this.host.archived();
    const row = (kind: 'note' | 'notebook', id: string, name: string, sub: string) => {
      const restore = h('button', { class: 'btn', type: 'button' }, 'Restore') as HTMLButtonElement;
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        await this.host.unarchive(kind, id);
        this.renderArchived();
      });
      const del = h('button', { class: 'btn danger-text', type: 'button', 'aria-label': `Delete "${name}"` }, 'Delete') as HTMLButtonElement;
      del.addEventListener('click', async () => {
        await this.host.deleteArchived(kind, id);
        this.renderArchived();
        this.renderTrash();
      });
      return h('li', {}, h('div', { class: 'archived-name' }, h('span', { class: 'archived-kind' }, kind === 'note' ? 'Note' : 'Notebook'), h('b', {}, name), h('small', {}, sub)), h('div', { class: 'row-actions' }, restore, del));
    };
    const items = [
      ...notebooks.map((b) => row('notebook', b.id, b.name, b.notes === 1 ? '1 note' : `${b.notes} notes`)),
      ...notes.map((n) => row('note', n.id, n.title || 'Untitled', `in ${n.notebook}`)),
    ];
    this.archivedBody.replaceChildren(items.length ? h('ul', { class: 'archived-items' }, ...items) : h('p', { class: 'muted' }, 'Nothing is archived.'));
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

    const theme = h(
      'select',
      { class: 'dlg-input' },
      h('option', { value: 'system' }, 'Same as this device'),
      h('option', { value: 'light' }, 'Light'),
      h('option', { value: 'dark' }, 'Dark'),
    ) as HTMLSelectElement;
    theme.value = themeChoice();
    theme.addEventListener('change', () => setTheme(theme.value as ThemeChoice));
    this.addSync(() => (theme.value = themeChoice()));

    return [
      this.card(
        'Appearance',
        this.row(
          'Theme',
          theme,
          'Light or dark, or follow this device’s setting. In dark mode the page is dark too, and ink is shown in lighter colours so it stays readable; your notes, exports and PDFs keep their real colours. Saved on this device.',
        ),
      ),
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
      this.refreshPalm();
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
      this.refreshPalm();
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

    // Automatic (the default) learns the writing contact each time the app opens. A fixed limit is
    // used only while its own switch is on, so it is never in effect by accident; while on, a note
    // says automatic detection is off.
    const mode = this.toggle(
      'Set the palm limit myself',
      'Off (recommended): Lineboard learns how big your writing contact is (a finger, a rubber-tipped stylus, a fine pen) from your first few strokes each time you open it, and treats touches much bigger than that as a resting palm. On: a fixed limit you set below is used instead, and nothing is learned.',
      () => s().palmMode === 'manual',
      (on) => {
        s().palmMode = on ? 'manual' : 'auto';
        paint();
      },
    );
    const status = h('p', { class: 'muted palm-status' });
    const manualNote = h('p', { class: 'enc-warn palm-manual-note' });
    const manual = h(
      'div',
      { class: 'palm-manual' },
      this.row('Ignore touches larger than', h('div', { class: 'range' }, thr, thrVal), 'Palms register as big contacts, a pen tip as a small one. Write in the box below with your stylus to set the limit from it.'),
      h('div', { class: 'cal' }, pad, h('div', { class: 'cal-side' }, calOut, h('div', { class: 'cal-btns' }, useCal, resetCal))),
    );
    function paint() {
      const on = s().palmMode === 'manual';
      manual.hidden = !on;
      manualNote.hidden = !on;
      manualNote.textContent = `Automatic detection is off: touches larger than ${s().touchThreshold} px are ignored. Turn the switch off to let Lineboard learn your writing again.`;
      status.hidden = on;
      status.textContent = palmStatus();
    }
    const palmStatus = () => this.host.palmStatus();
    this.refreshPalm = paint;

    this.addSync(() => {
      thr.value = String(s().touchThreshold);
      thrVal.textContent = s().touchThreshold + ' px';
      paint();
    });

    return [
      this.card(
        'Palm rejection inside the unlocked strip',
        status,
        mode,
        manualNote,
        manual,
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
        h('div', {}, h('div', { class: 'set-label with-info' }, 'End-to-end encryption', infoButton('End-to-end encryption', ENC_INFO)), h('small', { class: 'muted enc-status' }, status)),
        toggle,
      );

    if (!vault) {
      const msg = this.host.signInButton
        ? 'Encryption is available with an account. Notes you make without one stay in this browser and are never uploaded.'
        : 'Local mode keeps notes only on this device; nothing is uploaded, so there is nothing to encrypt in transit.';
      body.replaceChildren(this.card(null, header(sw(false, true), msg), this.host.signInButton ? this.host.signInButton() : null));
      return;
    }
    if (!vault.supported) {
      body.replaceChildren(
        this.card(null, header(sw(false, true), 'Not available yet: this server’s database needs an update first. Its operator re-runs supabase/schema.sql.')),
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
        this.infoCard(
          'Keys',
          'Lost your recovery key, or think someone saw it? Make a new one; the old one stops working. Lock this device makes Lineboard forget the key here, so the passphrase is needed again.',
          h('div', { class: 'set-buttons' }, change, recovery, lock),
        ),
      );
    }
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
