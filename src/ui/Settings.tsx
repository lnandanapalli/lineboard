import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { PAGE_W } from '../board';
import { changePassphrase, disableEncryption, enableEncryption, replaceRecoveryKey } from './Encryption';
import { icons } from '../icons';
import { SupabaseStore } from '../store/supabaseStore';
import type { AccountSecurity } from '../account';
import { confirmItsYou, SecurityPane } from './Security';
import type { Store } from '../store/store';
import { TRASH_DAYS, type AppUser, type Paper, type Settings } from '../types';
import { dialog } from './overlays';
import { toast } from './Toast';
import { isApple, shortcut } from '../keys';
import { orientation } from '../orientation';
import { avatar, MAX_NAME, type Profile } from '../profile';
import { setTheme, themeChoice, type ThemeChoice } from '../theme';
import { IMAGE_TYPES } from '../images';
import { InfoButton } from './overlays';
import { Svg } from './Icon';
import { Card } from './Card';
import { Mount } from './Mount';

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
  /** Guest mode: go to sign-in ("Sign in to save"). */
  signIn?: () => void;
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
  /** What is in the trash: notes moved there, and notebooks moved there whole (with their notes' titles). */
  trash: () => { notebooks: { id: string; name: string; notes: string[]; deleted_at: string }[]; notes: { id: string; title: string; deleted_at: string }[] };
  /** A note asks which notebook to go to; a notebook comes back whole. */
  restoreTrashed: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  /** Delete one item for good (asks first). */
  deleteTrashed: (kind: 'note' | 'notebook', id: string) => Promise<void>;
  /** Delete everything in the trash for good (asks first). */
  emptyTrash: () => Promise<void>;
}

interface PanelState {
  open: boolean;
  section: Section;
  /** On narrow screens the section list and the section are separate views: a section is showing. */
  paneOpen: boolean;
  /** Bumped when what the panel shows may have changed (lists, palm status). */
  rev: number;
  contact: string;
}

/**
 * The settings window (React draws it: SettingsDialog). This object is how the app opens it and
 * tells it about changes.
 */
export class SettingsPanel {
  readonly state = createStore<PanelState>(() => ({ open: false, section: 'account', paneOpen: false, rev: 0, contact: 'Last contact on page: none yet' }));
  constructor(readonly host: SettingsHost) {}

  private bump(extra: Partial<PanelState> = {}) {
    this.state.setState((s) => ({ ...extra, rev: s.rev + 1 }));
  }

  open(section?: Section) {
    flushSync(() => this.bump({ open: true, ...(section ? { section, paneOpen: true } : {}) }));
  }

  /** Open at Data controls, with the trash in view. */
  openTrash() {
    this.open('data');
    document.querySelector('.trash-list')?.closest('.set-card')?.scrollIntoView({ block: 'start' });
  }

  close() {
    this.state.setState({ open: false });
  }

  destroy() {
    this.close();
  }

  /** The library changed (maybe on another device): redraw the archive and trash lists if open. */
  refreshLists() {
    if (this.state.getState().open) this.bump();
  }

  /** The last contact on the page (stylus & palm section). */
  showContact(size: number, type: string, accepted: boolean) {
    const reason = accepted ? 'drawn' : 'ignored';
    this.bump({ contact: `Last contact on page: ${size ? Math.round(size) + ' px' : 'size not reported'} (${type}, ${reason})` });
  }

  show(section: Section) {
    this.bump({ section, paneOpen: true });
  }
}

/** Re-render after changing a setting in place (settings live in an object the app owns). */
const useRefresh = () => useReducer((n: number) => n + 1, 0)[1];

export function SettingsDialog({ panel }: { panel: SettingsPanel }) {
  const { open, section, paneOpen, rev } = useStore(panel.state);
  const d = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = d.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return createPortal(
    <dialog
      className="modal settings-modal"
      ref={d}
      onClose={() => panel.close()}
      onClick={(e) => {
        if (e.target === d.current) panel.close();
      }}
    >
      <div className={'settings-shell' + (paneOpen ? ' pane-open' : '')}>
        <div className="settings-side">
          <h2>Settings</h2>
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button key={s.id} className={'settings-tab' + (s.id === section ? ' active' : '')} type="button" data-section={s.id} aria-current={s.id === section ? 'page' : 'false'} onClick={() => panel.show(s.id)}>
                <Svg icon={s.icon} />
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="settings-main">
          <div className="settings-content">
            {/* Every section is drawn afresh each time the window opens (Sign-in & devices only while shown: it loads from the server). */}
            {SECTIONS.map((s) => (
              <section key={s.id} className="settings-pane" data-section={s.id} aria-label={s.label} hidden={s.id !== section}>
                <div className="pane-head">
                  <button className="icon-btn settings-back" type="button" aria-label="All settings" title="All settings" onClick={() => panel.state.setState({ paneOpen: false })}>
                    <Svg icon={icons.chevron} />
                  </button>
                  <h3>{s.label}</h3>
                </div>
                {open && <Pane id={s.id} panel={panel} rev={rev} current={s.id === section} key={s.id} />}
              </section>
            ))}
          </div>
          <div className="settings-foot">
            <button className="btn primary" type="button" onClick={() => panel.close()}>
              Done
            </button>
          </div>
        </div>
        <button className="icon-btn settings-close" type="button" aria-label="Close settings" title="Close" onClick={() => panel.close()}>
          <Svg icon={icons.close} />
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

function Pane({ id, panel, rev, current }: { id: Section; panel: SettingsPanel; rev: number; current: boolean }) {
  const host = panel.host;
  switch (id) {
    case 'account':
      return <AccountPane host={host} />;
    case 'data':
      return <DataPane host={host} rev={rev} />;
    case 'signin':
      // Loaded from the server each time the section is shown.
      if (!host.account) return <SigninPane host={host} />;
      return current ? <SecurityPane account={host.account} email={host.user.email} /> : null;
    case 'security':
      return <EncryptionPane host={host} />;
    case 'writing':
      return <WritingPane host={host} />;
    case 'stylus':
      return <StylusPane panel={panel} />;
    case 'about':
      return <AboutPane />;
  }
}

// ----------------------------- helpers -----------------------------

/** A setting: its label (with an ⓘ for the explanation, if any) and its control (named by `label`). */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-label with-info">
        {label}
        {help && <InfoButton topic={label} text={help} />}
      </span>
      {children}
    </div>
  );
}

/** A labelled on/off switch row (the settings-screen standard, instead of a bare checkbox). */
function Toggle({ label, help, on, set }: { label: string; help: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="set-switch">
      <div className="set-label with-info">
        {label}
        <InfoButton topic={label} text={help} />
      </div>
      <Switch label={label} on={on} onClick={() => set(!on)} />
    </div>
  );
}

function Switch({ label, on, disabled, onClick }: { label: string; on: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}>
      <i className="knob" />
    </button>
  );
}

function SignInButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn primary signin-save signin-settings" type="button" title="Sign in or create an account to save your notes" onClick={onClick}>
      <Svg icon={icons.cloud} />
      <span>Sign in to save</span>
    </button>
  );
}

// ----------------------------- account -----------------------------

/** Name and picture: shown in the sidebar instead of the email. */
function ProfileCard({ host }: { host: SettingsHost }) {
  const [, setTick] = useState(0);
  const { profile, url } = host.profile();
  const [name, setName] = useState(profile.name);
  const [busy, setBusy] = useState<'name' | 'pick' | 'remove' | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const pic = useRef<HTMLElement | null>(null);
  const [picEl, setPicEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    pic.current = avatar(profile, url, 64);
    setPicEl(pic.current);
  }, [profile, url]);
  const run = async (which: 'name' | 'pick' | 'remove', fn: () => Promise<void>) => {
    setBusy(which);
    try {
      await fn();
      setName(host.profile().profile.name);
      setTick((n) => n + 1);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const saveName = () =>
    void run('name', async () => {
      await host.changeProfile({ name });
      toast('Name saved.');
    });
  return (
    <Card
      title="Profile"
      info={`Your name and picture are shown in the sidebar instead of your email. Up to ${MAX_NAME} characters; leave the name empty for none.${host.user.email ? ' They are stored with your account.' : ''}`}
    >
      <div className="profile-edit">
        <div className="profile-row">
          {picEl && <Mount el={picEl} />}
          <div className="row-actions">
            <button className="btn" type="button" disabled={busy === 'pick'} onClick={() => file.current?.click()}>
              {profile.picture ? 'Change picture' : 'Add picture'}
            </button>
            {profile.picture && (
              <button className="btn danger-text" type="button" disabled={busy === 'remove'} onClick={() => void run('remove', () => host.changeProfile({ picture: null }))}>
                Remove picture
              </button>
            )}
            <input
              ref={file}
              type="file"
              accept={IMAGE_TYPES}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void run('pick', () => host.changeProfile({ picture: f }));
              }}
            />
          </div>
        </div>
        <label className="field-label">Display name</label>
        <div className="profile-name">
          <input
            type="text"
            className="dlg-input"
            maxLength={MAX_NAME}
            placeholder="Your name"
            aria-label="Display name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName();
            }}
          />
          <button className="btn primary" type="button" disabled={busy === 'name'} onClick={saveName}>
            Save name
          </button>
        </div>
      </div>
    </Card>
  );
}

function AccountPane({ host }: { host: SettingsHost }) {
  const { user, store, signOut, signIn } = host;
  const where = signOut ? 'Your notebooks sync to your account, so they are on every device you sign in to.' : 'Notes stay in this browser on this device.';
  return (
    <>
      <ProfileCard host={host} />
      <Card>
        <div className="set-account">
          {signOut ? (
            <>
              <div className="profile">
                <div>
                  <div className="muted text-small">Signed in as</div>
                  <b>{user.email ?? ''}</b>
                </div>
              </div>
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  if (host.pendingSaves()) {
                    const ok = await dialog({ title: 'Unsaved changes', message: 'Some strokes are still being saved. Sign out anyway?', ok: 'Sign out', danger: true });
                    if (!ok) return;
                  }
                  await signOut();
                }}
              >
                Sign out
              </button>
            </>
          ) : signIn ? (
            <>
              <span>You're trying Lineboard without an account. Notes are saved only in this browser. Sign in or create a free account to keep them and use them on other devices.</span>
              <SignInButton onClick={signIn} />
            </>
          ) : (
            <span>Local mode. Configure Supabase to sync across devices.</span>
          )}
        </div>
      </Card>
      <Card title="Storage" info={store.mode === 'cloud' ? 'Changes save in the background and wait while you are offline.' : 'Nothing leaves this device.'}>
        <p className="muted">{where}</p>
      </Card>
    </>
  );
}

// ----------------------------- data controls -----------------------------

/** Data controls: the trash, what is archived, a copy of everything, moving notes, and erasing it all. */
function DataPane({ host, rev }: { host: SettingsHost; rev: number }) {
  const refresh = useRefresh();
  const [exporting, setExporting] = useState(false);
  const erase = host.deleteAccount ?? host.deleteLocalData;
  void rev; // a new `rev` re-renders the lists
  return (
    <>
      <Card
        title="Trash"
        info={`Deleted notes and notebooks wait here for ${TRASH_DAYS} days, then they are deleted for good. A note you restore goes into a notebook you pick. A deleted notebook comes back whole, with its notes.`}
      >
        <TrashList host={host} refresh={refresh} />
      </Card>
      <Card title="Archived" info="Archived notes and notebooks are hidden from the sidebar and search. They are kept, with their history, until you restore or delete them. Archive one from its ⋯ menu.">
        <ArchivedList host={host} refresh={refresh} />
      </Card>
      <Card
        title="Your data"
        info="Download my data: a copy of everything, your account details and settings, and all your notebooks, notes (with their version history) and pictures as a Lineboard file (.lbd) you can import again. Export and import move notes between accounts or devices; exporting all notes keeps their version history, while a single note or notebook exported from the Notes list to share has only its current content."
      >
        <div className="row-actions">
          <button
            className="btn"
            type="button"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                await host.exportData();
              } finally {
                setExporting(false);
              }
            }}
          >
            Download my data
          </button>
          <button className="btn" type="button" onClick={() => void host.exportAll()}>
            Export all notes (.lbd)
          </button>
          <button className="btn" type="button" onClick={() => host.importNotes()}>
            Import notes
          </button>
        </div>
      </Card>
      {erase && (
        <Card
          title={host.deleteAccount ? 'Delete account' : 'Delete local data'}
          info={
            host.deleteAccount
              ? 'Deleting your account removes it and everything in it from our servers, permanently. You are asked to confirm first.'
              : 'Deleting removes every note and picture saved in this browser, permanently. You are asked to confirm first.'
          }
        >
          <div className="row-actions">
            <button className="btn danger" type="button" onClick={() => void erase()}>
              {host.deleteAccount ? 'Delete account' : 'Delete everything on this device'}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

function ListRow({ kind, name, sub, inside, children }: { kind: 'note' | 'notebook'; name: string; sub: string; inside?: string[]; children: ReactNode }) {
  return (
    <li className={kind === 'notebook' && inside ? 'trash-book' : ''}>
      <div className="archived-name">
        <span className="archived-kind">{kind === 'note' ? 'Note' : 'Notebook'}</span>
        <b>{name}</b>
        <small>{sub}</small>
        {inside && inside.length > 0 && (
          <ul className="trash-inside" aria-label={`Notes in "${name}"`}>
            {inside.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="row-actions">{children}</div>
    </li>
  );
}

/**
 * What is in the trash. A note: Restore (pick a notebook) and Delete forever. A notebook: its notes
 * listed under it (they cannot be taken out one by one), Restore and Delete forever, whole.
 */
function TrashList({ host, refresh }: { host: SettingsHost; refresh: () => void }) {
  const { notebooks, notes } = host.trash();
  const [restoring, setRestoring] = useState<string | null>(null);
  const left = (at: string) => {
    const days = Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - Date.parse(at)) / 86_400_000));
    return days <= 1 ? 'deleted for good within a day' : `deleted for good in ${days} days`;
  };
  const actions = (kind: 'note' | 'notebook', id: string, name: string) => (
    <>
      <button
        className="btn"
        type="button"
        aria-label={`Restore "${name}"`}
        disabled={restoring === id}
        onClick={async () => {
          setRestoring(id);
          await host.restoreTrashed(kind, id);
          setRestoring(null);
          refresh();
        }}
      >
        {kind === 'note' ? 'Restore…' : 'Restore'}
      </button>
      <button
        className="btn danger-text"
        type="button"
        aria-label={`Delete "${name}" forever`}
        onClick={async () => {
          await host.deleteTrashed(kind, id);
          refresh();
        }}
      >
        Delete forever
      </button>
    </>
  );
  const count = notebooks.length + notes.length;
  return (
    <div className="archived-list trash-list">
      {count === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <>
          <ul className="archived-items">
            {notebooks.map((b) => (
              <ListRow key={b.id} kind="notebook" name={b.name} sub={`${b.notes.length === 1 ? '1 note' : `${b.notes.length} notes`} · ${left(b.deleted_at)}`} inside={b.notes}>
                {actions('notebook', b.id, b.name)}
              </ListRow>
            ))}
            {notes.map((n) => (
              <ListRow key={n.id} kind="note" name={n.title || 'Untitled'} sub={left(n.deleted_at)}>
                {actions('note', n.id, n.title || 'Untitled')}
              </ListRow>
            ))}
          </ul>
          <div className="row-actions trash-empty">
            <button
              className="btn danger-text"
              type="button"
              onClick={async () => {
                await host.emptyTrash();
                refresh();
              }}
            >
              Empty trash
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** What is archived, each with Restore and Delete. */
function ArchivedList({ host, refresh }: { host: SettingsHost; refresh: () => void }) {
  const { notebooks, notes } = host.archived();
  const [restoring, setRestoring] = useState<string | null>(null);
  const actions = (kind: 'note' | 'notebook', id: string, name: string) => (
    <>
      <button
        className="btn"
        type="button"
        disabled={restoring === id}
        onClick={async () => {
          setRestoring(id);
          await host.unarchive(kind, id);
          setRestoring(null);
          refresh();
        }}
      >
        Restore
      </button>
      <button
        className="btn danger-text"
        type="button"
        aria-label={`Delete "${name}"`}
        onClick={async () => {
          await host.deleteArchived(kind, id);
          refresh();
        }}
      >
        Delete
      </button>
    </>
  );
  return (
    <div className="archived-list">
      {notebooks.length + notes.length === 0 ? (
        <p className="muted">Nothing is archived.</p>
      ) : (
        <ul className="archived-items">
          {notebooks.map((b) => (
            <ListRow key={b.id} kind="notebook" name={b.name} sub={b.notes === 1 ? '1 note' : `${b.notes} notes`}>
              {actions('notebook', b.id, b.name)}
            </ListRow>
          ))}
          {notes.map((n) => (
            <ListRow key={n.id} kind="note" name={n.title || 'Untitled'} sub={`in ${n.notebook}`}>
              {actions('note', n.id, n.title || 'Untitled')}
            </ListRow>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------- sign-in & devices (no account) -----------------------------

function SigninPane({ host }: { host: SettingsHost }) {
  return (
    <Card>
      <p className="muted">{host.signIn ? 'Sign in to manage your password, two-step verification, passkeys and signed-in devices.' : 'Local mode has no accounts, so there is nothing to sign in to.'}</p>
      {host.signIn && <SignInButton onClick={host.signIn} />}
    </Card>
  );
}

// ----------------------------- page & writing -----------------------------

const smoothText = (v: number) => (v === 0 ? 'Off' : v < 0.2 ? 'Light' : v < 0.5 ? 'Medium' : v < 0.8 ? 'Strong' : 'Very strong');

function WritingPane({ host }: { host: SettingsHost }) {
  const refresh = useRefresh();
  const s = host.settings();
  const change = (fn: () => void) => {
    fn();
    host.changed();
    refresh();
  };
  const [theme, setThemeState] = useState<ThemeChoice>(themeChoice());
  const px = Math.round((s.stripHeight * (document.querySelector('.canvas-area')?.clientWidth ?? PAGE_W)) / PAGE_W);
  return (
    <>
      <Card title="Appearance">
        <Row
          label="Theme"
          help="Light or dark, or follow this device’s setting. In dark mode the page is dark too, and ink is shown in lighter colours so it stays readable; your notes, exports and PDFs keep their real colours. Saved on this device."
        >
          <select
            className="dlg-input"
            aria-label="Theme"
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value as ThemeChoice);
              setThemeState(e.target.value as ThemeChoice);
            }}
          >
            <option value="system">Same as this device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Row>
      </Card>
      <Card title="Strips">
        <Row label="Strip height" help="Taller strips leave more room for big handwriting.">
          <div className="range">
            <input type="range" min={40} max={220} step={5} aria-label="Strip height" value={s.stripHeight} onChange={(e) => change(() => (s.stripHeight = Number(e.target.value)))} />
            <output>{`${s.stripHeight} (~ ${px} px on this screen)`}</output>
          </div>
        </Row>
        <Row label="Lock icons on the">
          <select aria-label="Lock icons on the" value={s.marginSide} onChange={(e) => change(() => (s.marginSide = e.target.value as 'left' | 'right'))}>
            <option value="left">Left (right-handed)</option>
            <option value="right">Right (left-handed)</option>
          </select>
        </Row>
        <Toggle label="Ruled lines" help="Show a line between strips." on={s.showLines} set={(on) => change(() => (s.showLines = on))} />
      </Card>
      <Card title="Free whiteboard">
        <Row label="Paper" help="The background of the free whiteboard (Mode menu → Free whiteboard).">
          <select aria-label="Free whiteboard paper" value={s.paper} onChange={(e) => change(() => (s.paper = e.target.value as Paper))}>
            <option value="plain">Plain</option>
            <option value="lines">Lined</option>
            <option value="grid">Grid</option>
            <option value="dots">Dots</option>
          </select>
        </Row>
      </Card>
      <Card title="Ink">
        <Row label="Smoothing" help="Steadies shaky lines as you write. Turn it down if strokes feel like they lag behind the pen.">
          <div className="range">
            <input type="range" min={0} max={1} step={0.05} aria-label="Smoothing" value={s.smoothing} onChange={(e) => change(() => (s.smoothing = Number(e.target.value)))} />
            <output>{smoothText(s.smoothing)}</output>
          </div>
        </Row>
      </Card>
      <Card title="Display">
        <Toggle
          label="Manual orientation"
          help="Keep the layout fixed to this device even when it rotates, and turn it yourself with the rotate button in the toolbar. Saved on this device only."
          on={orientation.manual}
          set={(on) => {
            orientation.setManual(on);
            host.changed();
            refresh();
          }}
        />
      </Card>
    </>
  );
}

// ----------------------------- stylus & palm -----------------------------

function StylusPane({ panel }: { panel: SettingsPanel }) {
  const host = panel.host;
  const refresh = useRefresh();
  const contact = useStore(panel.state, (st) => st.contact);
  useStore(panel.state, (st) => st.rev); // the palm status follows learning
  const s = host.settings();
  const change = (fn: () => void) => {
    fn();
    host.changed();
    refresh();
  };
  const [samples, setSamples] = useState<number[]>([]);
  const sample = (e: React.PointerEvent) => {
    if (e.buttons === 0 && e.type === 'pointermove') return;
    setSamples((list) => [...list, Math.max(e.width || 0, e.height || 0)]);
  };
  const manual = s.palmMode === 'manual';
  return (
    <>
      <Card title="Palm rejection inside the unlocked strip">
        <p className="muted palm-status" hidden={manual}>
          {host.palmStatus()}
        </p>
        <Toggle
          label="Set the palm limit myself"
          help="Off (recommended): Lineboard learns how big your writing contact is (a finger, a rubber-tipped stylus, a fine pen) from your first few strokes each time you open it, and treats touches much bigger than that as a resting palm. On: a fixed limit you set below is used instead, and nothing is learned."
          on={manual}
          set={(on) => change(() => (s.palmMode = on ? 'manual' : 'auto'))}
        />
        <p className="enc-warn palm-manual-note" hidden={!manual}>
          {`Automatic detection is off: touches larger than ${s.touchThreshold} px are ignored. Turn the switch off to let Lineboard learn your writing again.`}
        </p>
        <div className="palm-manual" hidden={!manual}>
          <Row label="Ignore touches larger than" help="Palms register as big contacts, a pen tip as a small one. Write in the box below with your stylus to set the limit from it.">
            <div className="range">
              <input type="range" min={5} max={150} step={1} aria-label="Ignore touches larger than" value={s.touchThreshold} onChange={(e) => change(() => (s.touchThreshold = Number(e.target.value)))} />
              <output>{s.touchThreshold + ' px'}</output>
            </div>
          </Row>
          <div className="cal">
            <div
              className="cal-pad"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                sample(e);
              }}
              onPointerMove={sample}
            >
              Write here with your stylus
            </div>
            <div className="cal-side">
              <span className="cal-out">{samples.length ? `Stylus contact: up to ${Math.round(Math.max(...samples))} px over ${samples.length} samples.` : 'No samples yet.'}</span>
              <div className="cal-btns">
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (!samples.length) return toast('Write in the box with your stylus first.');
                    const max = Math.max(...samples);
                    if (max <= 1) return toast('This browser does not report contact size, so size filtering cannot help here. Strips still work.');
                    const v = Math.min(150, Math.max(5, Math.ceil(max * 1.4 + 4)));
                    change(() => (s.touchThreshold = v));
                    toast(`Palm limit set to ${v} px.`);
                  }}
                >
                  Set limit from samples
                </button>
                <button className="btn" type="button" onClick={() => setSamples([])}>
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>
        <p className="readout">{contact}</p>
      </Card>
      <Card title="Active pens">
        <Toggle label="Ignore fingers when a pen is used" help="If an active pen is detected, finger touches never draw." on={s.penOnlyWhenPenSeen} set={(on) => change(() => (s.penOnlyWhenPenSeen = on))} />
      </Card>
    </>
  );
}

// ----------------------------- encryption -----------------------------

function EncryptionPane({ host }: { host: SettingsHost }) {
  const refresh = useRefresh();
  const store = host.store;
  const vault = store instanceof SupabaseStore ? store.vault : undefined;
  const header = (toggle: ReactNode, status: string) => (
    <div className="set-switch">
      <div>
        <div className="set-label with-info">
          End-to-end encryption
          <InfoButton topic="End-to-end encryption" text={ENC_INFO} />
        </div>
        <small className="muted enc-status">{status}</small>
      </div>
      {toggle}
    </div>
  );
  if (!vault) {
    const msg = host.signIn
      ? 'Encryption is available with an account. Notes you make without one stay in this browser and are never uploaded.'
      : 'Local mode keeps notes only on this device; nothing is uploaded, so there is nothing to encrypt in transit.';
    return (
      <div className="pane-stack">
        <Card>
          {header(<Switch label="End-to-end encryption" on={false} disabled />, msg)}
          {host.signIn && <SignInButton onClick={host.signIn} />}
        </Card>
      </div>
    );
  }
  if (!vault.supported) {
    return (
      <div className="pane-stack">
        <Card>{header(<Switch label="End-to-end encryption" on={false} disabled />, 'Not available yet: this server’s database needs an update first. Its operator re-runs supabase/schema.sql.')}</Card>
      </div>
    );
  }
  const state = vault.state;
  const on = vault.writeEncrypted;
  const status = {
    off: 'Off. Your notes are stored on the server without end-to-end encryption.',
    encrypting: 'Turning on: some notes are still being encrypted. This finishes the next time you open Lineboard.',
    on: 'On. Everything you write is encrypted on this device before it is saved.',
    decrypting: 'Turning off: some notes are still being decrypted.',
  }[state];
  const ctx = { vault, store: store as SupabaseStore, email: host.user.email, noteCount: host.noteCount() };
  const toggle = async () => {
    if (on) await disableEncryption(ctx);
    else {
      // Someone with an unlocked device must not be able to lock the owner out with their own passphrase.
      if (host.account && !(await confirmItsYou(host.account, host.user.email, 'Encryption changes who can read your notes.'))) return;
      await enableEncryption(ctx);
    }
    refresh();
  };
  return (
    <div className="pane-stack">
      <Card>{header(<Switch label="End-to-end encryption" on={on} disabled={state === 'decrypting'} onClick={() => void toggle()} />, status)}</Card>
      {on && (
        <Card title="Keys" info="Lost your recovery key, or think someone saw it? Make a new one; the old one stops working. Lock this device makes Lineboard forget the key here, so the passphrase is needed again.">
          <div className="set-buttons">
            <button className="btn" type="button" onClick={() => void changePassphrase(vault)}>
              Change passphrase
            </button>
            <button className="btn" type="button" onClick={() => void replaceRecoveryKey(vault, host.user.email)}>
              New recovery key
            </button>
            <button
              className="btn"
              type="button"
              onClick={async () => {
                const ok = await dialog({
                  title: 'Lock this device?',
                  message: 'Lineboard forgets the key on this device. You will need your encryption passphrase to open your notes here again.',
                  ok: 'Lock',
                });
                if (!ok) return;
                await vault.lock();
                location.reload();
              }}
            >
              Lock this device
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ----------------------------- about -----------------------------

const SHORTCUTS: [string[], string][] = [
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
];

function AboutPane() {
  const link = (href: string, text: string) => (
    <a href={href} target="_blank" rel="noopener">
      {text}
    </a>
  );
  return (
    <>
      <Card>
        <p>Lineboard is a handwriting whiteboard for tablets without an active pen: write above the line, and rest your hand below it.</p>
        <p className="set-links">
          {link('/home', 'About Lineboard')} · {link('/terms', 'Terms of service')} · {link('/privacy', 'Privacy policy')} · {link('https://github.com/lnandanapalli/lineboard', 'Source code')}
        </p>
      </Card>
      <Card title="Keyboard shortcuts">
        <dl className="shortcuts">
          {SHORTCUTS.map(([combos, what]) => (
            <div key={what} style={{ display: 'contents' }}>
              <dt>
                {combos.map((c, i) => (
                  <span key={c} style={{ display: 'contents' }}>
                    {i ? ' ' : null}
                    <kbd>{shortcut(c)}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
