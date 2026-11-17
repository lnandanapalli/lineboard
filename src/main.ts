import { createClient, type Session } from '@supabase/supabase-js';
import './styles.css';
import { App } from './app';
import { renderHome, renderPolicy } from './public';
import { renderAuth, renderNewPassword } from './auth';
import { logo } from './brand';
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
  let localApp: App | null = null;
  const route = () => {
    localApp?.destroy();
    localApp = null;
    const page = location.hash.slice(1);
    if (page === 'terms' || page === 'privacy') renderPolicy(root, page);
    else if (page === 'app' || (!page && isGuestActive())) {
      setGuestActive(true);
      document.title = 'Lineboard';
      localApp = new App(root, new LocalStore(), LOCAL_USER);
    } else renderHome(root, false, () => { location.hash = 'app'; });
  };
  window.addEventListener('hashchange', route);
  route();
} else {
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let app: App | null = null;
  /** Who the screen currently belongs to: a user id, 'guest', null (public screen) or undefined (nothing yet). */
  let current: string | null | undefined;
  let recovering = false;
  // Undefined means auth has not finished restoring the saved session yet.
  let activeSession: Session | null | undefined;

  const clearApp = () => {
    app?.destroy();
    app = null;
  };

  /** Trying Lineboard without an account: device-only notes, with "Sign in to save". */
  const startGuest = () => {
    // A stale public-page action must never switch an authenticated user to local data.
    if (activeSession === undefined) return;
    if (activeSession) {
      history.replaceState(null, '', '#app');
      void show(activeSession);
      return;
    }
    clearApp();
    setGuestActive(true);
    current = 'guest';
    history.replaceState(null, '', '#app');
    document.title = 'Lineboard';
    app = new App(root, new LocalStore(), LOCAL_USER, { signIn: () => { lsSet(GUEST_MIGRATE, true); location.hash = 'login'; } });
  };

  /** A guest pressed "Sign in to save": show sign-in, then move their notes after they sign in. */
  const showGuestSignIn = async () => {
    lsSet(GUEST_MIGRATE, true);
    clearApp();
    current = null;
    const noteCount = (await guestNotesWithInk(new LocalStore())).length;
    if (!['#login', '#signup'].includes(location.hash) || current !== null) return;
    renderAuth(root, sb, {
      initialMode: location.hash === '#signup' ? 'signup' : 'signin',
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
    renderAuth(root, sb, { initialMode: location.hash === '#signup' ? 'signup' : 'signin', onTryLocal: startGuest });
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
    activeSession = session;
    if (recovering) return;
    const page = location.hash.slice(1);
    if (page === 'terms' || page === 'privacy' || page === 'home' || page === 'how-it-works') {
      clearApp();
      current = null;
      if (page === 'terms' || page === 'privacy') renderPolicy(root, page);
      else renderHome(root, true, () => { location.hash = 'app'; }, !!session);
      return;
    }
    if (!session) {
      if (current === 'guest' || current === null) return; // already on a signed-out screen
      if (page === 'login' || page === 'signup') {
        if (lsGet<boolean>(GUEST_MIGRATE, false)) void showGuestSignIn();
        else showSignIn();
      } else if (page === 'app' || isGuestActive()) startGuest();
      else {
        current = null;
        renderHome(root, true, () => { location.hash = 'app'; });
      }
      return;
    }
    const uid = session.user.id;
    if (current === uid) return; // token refresh etc.
    clearApp();
    history.replaceState(null, '', '#app');
    document.title = 'Lineboard';
    current = uid; // set before awaiting, so repeated auth events don't run this twice
    setGuestActive(false);
    const store = new SupabaseStore(sb, uid);
    await maybeMoveGuestNotes(store, uid);
    if (current !== uid) return; // signed out meanwhile
    app = new App(root, store, { id: uid, email: session.user.email ?? null }, {
      signOut: async () => {
        const { error } = await sb.auth.signOut();
        if (error) { toast(error.message, 'error'); return; }
        setGuestActive(false);
        activeSession = null;
        location.hash = 'home';
      },
    });
  };

  window.addEventListener('hashchange', () => {
    if (recovering || activeSession === undefined) return;
    clearApp();
    current = undefined;
    void show(activeSession);
  });

  sb.auth.onAuthStateChange((event, session) => {
    activeSession = session;
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
      if (activeSession !== undefined) void show(activeSession);
    }, 0);
  });
}
