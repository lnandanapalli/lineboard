import { createClient, type Session } from '@supabase/supabase-js';
import './styles.css';
import { App } from './app';
import { logo, renderAuth, renderNewPassword } from './auth';
import { config, hasCloud } from './config';
import { GUEST_MIGRATE, guestNotesWithInk, isGuestActive, keepSeparateKey, migrateGuestData, setGuestActive } from './guest';
import { LocalStore } from './store/localStore';
import { SupabaseStore } from './store/supabaseStore';
import { h, lsGet, lsSet, toast } from './util';

const root = document.getElementById('app')!;
const LOCAL_USER = { id: 'local', email: null };

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

if (!hasCloud) {
  // No backend configured: run fully on this device.
  new App(root, new LocalStore(), LOCAL_USER);
} else {
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let app: App | null = null;
  /** Who the screen currently belongs to: a user id, 'guest', null (sign-in screen) or undefined (nothing yet). */
  let current: string | null | undefined;
  let recovering = false;

  const clearApp = () => {
    app?.destroy();
    app = null;
  };

  /** Trying Lineboard without an account: device-only notes, with "Sign in to save". */
  const startGuest = () => {
    clearApp();
    setGuestActive(true);
    current = 'guest';
    app = new App(root, new LocalStore(), LOCAL_USER, { signIn: () => void showGuestSignIn() });
  };

  /** A guest pressed "Sign in to save": show sign-in, then move their notes after they sign in. */
  const showGuestSignIn = async () => {
    lsSet(GUEST_MIGRATE, true);
    clearApp();
    current = null;
    const noteCount = (await guestNotesWithInk(new LocalStore())).length;
    renderAuth(root, sb, {
      guest: {
        noteCount,
        onBack: () => {
          localStorage.removeItem(GUEST_MIGRATE);
          startGuest();
        },
      },
    });
  };

  const showSignIn = () => {
    clearApp();
    current = null;
    renderAuth(root, sb, { onTryLocal: startGuest });
  };

  /** Ask a user who signed in normally whether this device's guest notes should join their account. */
  const askToMove = (count: number) =>
    new Promise<'move' | 'keep'>((resolve) => {
      const move = h('button', { class: 'btn primary wide', type: 'button' }, `Add ${count === 1 ? 'it' : 'them'} to my account`);
      const keep = h('button', { class: 'btn wide', type: 'button' }, 'Keep them separate on this device');
      move.addEventListener('click', () => resolve('move'));
      keep.addEventListener('click', () => resolve('keep'));
      root.replaceChildren(
        h(
          'div',
          { class: 'auth-screen' },
          h(
            'div',
            { class: 'auth-card migrate-card' },
            h('div', { class: 'brand' }, logo(), h('span', {}, 'Notes on this device')),
            h('p', {}, `This browser has ${count === 1 ? 'a note' : `${count} notes`} made without an account. Add ${count === 1 ? 'it' : 'them'} to your account?`),
            h('div', { class: 'migrate-actions' }, move, keep),
          ),
        ),
      );
    });

  const showBusy = (text: string) =>
    root.replaceChildren(h('div', { class: 'auth-screen' }, h('div', { class: 'auth-card migrate-card' }, h('div', { class: 'brand' }, logo(), h('span', {}, 'Lineboard')), h('p', {}, text))));

  /** Move guest notes into the account when appropriate. Never throws; on failure the local copy is kept. */
  const maybeMoveGuestNotes = async (store: SupabaseStore, uid: string) => {
    const local = new LocalStore();
    const notes = await guestNotesWithInk(local);
    if (!notes.length) return;
    const explicit = lsGet<boolean>(GUEST_MIGRATE, false);
    if (!explicit) {
      if (lsGet<boolean>(keepSeparateKey(uid), false)) return;
      if ((await askToMove(notes.length)) === 'keep') {
        lsSet(keepSeparateKey(uid), true);
        return;
      }
    }
    showBusy('Saving the notes from this device to your account...');
    try {
      const moved = await migrateGuestData(local, store, uid);
      toast(`Saved ${moved === 1 ? '1 note' : `${moved} notes`} from this device to your account.`);
    } catch (e) {
      console.error('Moving guest notes failed', e);
      toast('Could not save your notes from this device yet. They are still here and will be saved next time you sign in.', 'error');
    }
  };

  const show = async (session: Session | null) => {
    if (recovering) return;
    if (!session) {
      if (current === 'guest' || current === null) return; // already on a signed-out screen
      if (isGuestActive()) startGuest();
      else showSignIn();
      return;
    }
    const uid = session.user.id;
    if (current === uid) return; // token refresh etc.
    clearApp();
    current = uid; // set before awaiting, so repeated auth events don't run this twice
    setGuestActive(false);
    const store = new SupabaseStore(sb, uid);
    await maybeMoveGuestNotes(store, uid);
    if (current !== uid) return; // signed out meanwhile
    app = new App(root, store, { id: uid, email: session.user.email ?? null }, {
      signOut: async () => {
        await sb.auth.signOut();
      },
    });
  };

  sb.auth.onAuthStateChange((event, session) => {
    // Defer: calling Supabase from inside this callback can deadlock the auth lock.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') {
        recovering = true;
        clearApp();
        current = undefined;
        renderNewPassword(root, sb, () => {
          recovering = false;
          void show(session);
        });
        return;
      }
      void show(session);
    }, 0);
  });
}
