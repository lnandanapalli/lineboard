import { createClient, type Session } from '@supabase/supabase-js';
import './styles.css';
import { App } from './app';
import { installRouter, navigate, navigationEvent, pageName, replaceRoute } from './router';
import { showScreen } from './ui/screen';
import { config, hasCloud } from './config';
import { GUEST_MIGRATE, guestNotesWithInk, isGuestActive, keepSeparateKey, migrateGuestData, setGuestActive } from './guest';
import { LocalStore } from './store/localStore';
import { SupabaseStore } from './store/supabaseStore';
import { forgetAllRememberedKeys, forgetRememberedKey, KeyVault } from './crypto/vault';
import { AccountSecurity } from './account';
import { lsGet, lsSet } from './util';
import { toast } from './ui/Toast';

/**
 * Start the app: routing, sign-in, encryption, and the notes screen. The React root (main.tsx)
 * calls this once; it shows each screen through ui/screen.ts.
 */
export function boot() {
  /** Show the notes app (React draws it: ui/AppScreen.tsx). */
  const showApp = <T extends App>(app: T): T => {
    showScreen({ kind: 'app', app });
    return app;
  };
  /** Two-step verification: resolves once the code from the authenticator app was accepted. */
  const secondStep = async (account: AccountSecurity, signOut: () => void) => {
    const factors = await account.authenticators().catch(() => []);
    await new Promise<void>((done) => showScreen({ kind: 'second-step', account, factors, signOut, done }));
  };
  installRouter();
  const LOCAL_USER = { id: 'local', email: null };

  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    const register = () => void navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
    // boot() runs from React, possibly after the page's load event: register at once in that case.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  if (!hasCloud) {
    let localApp: App | null = null;
    const route = () => {
      localApp?.destroy();
      localApp = null;
      const page = pageName();
      if (page === 'terms' || page === 'privacy') showScreen({ kind: 'policy', page });
      else if (page === 'app' || (!page && isGuestActive())) {
        replaceRoute('/app');
        setGuestActive(true);
        document.title = 'Lineboard';
        localApp = showApp(new App(new LocalStore(), LOCAL_USER));
      } else showScreen({ kind: 'home', cloud: false, signedIn: false, onStart: () => navigate('/app') });
    };
    window.addEventListener(navigationEvent, route);
    route();
  } else {
    const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const account = new AccountSecurity(sb);

    /** This device was signed out elsewhere (another device, a password reset, turning on two-step verification). */
    const signedOutRemotely = async () => {
      await sb.auth.signOut({ scope: 'local' });
      toast('You were signed out on this device from another device or by a password change.', 'error');
    };
    // Notice a remote sign-out while the app is open, not only when the access token next expires.
    const checkStillSignedIn = async () => {
      if (!activeSession || typeof current !== 'string' || current === 'guest') return;
      if ((await account.sessionAlive()) === false) await signedOutRemotely();
    };
    setInterval(() => void checkStillSignedIn(), 5 * 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkStillSignedIn();
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
        replaceRoute('/app');
        void show(activeSession);
        return;
      }
      clearApp();
      setGuestActive(true);
      current = 'guest';
      replaceRoute('/app');
      document.title = 'Lineboard';
      app = showApp(new App(new LocalStore(), LOCAL_USER, { signIn: () => { lsSet(GUEST_MIGRATE, true); navigate('/login'); } }));
    };

    /** A guest pressed "Sign in to save": show sign-in, then move their notes after they sign in. */
    const showGuestSignIn = async () => {
      lsSet(GUEST_MIGRATE, true);
      clearApp();
      current = null;
      const noteCount = (await guestNotesWithInk(new LocalStore())).length;
      if (!['login', 'signup'].includes(pageName()) || current !== null) return;
      showScreen({
        kind: 'auth',
        sb,
        initialMode: pageName() === 'signup' ? 'signup' : 'signin',
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
      showScreen({ kind: 'auth', sb, initialMode: pageName() === 'signup' ? 'signup' : 'signin', onTryLocal: startGuest });
    };

    /** Ask a user who signed in normally whether this device's guest notes should join their account. */
    const askToMove = (count: number) => new Promise<'move' | 'keep'>((resolve) => showScreen({ kind: 'move-notes', count, answer: resolve }));

    const showBusy = (text: string) => showScreen({ kind: 'busy', text });

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
        if (moved) toast(`Saved ${moved === 1 ? '1 note' : `${moved} notes`} from this device to your account.`);
      } catch (e) {
        console.error('Moving guest notes failed', e);
        toast('Could not save your notes from this device yet. They are still here and will be saved next time you sign in.', 'error');
      }
    };

    /**
     * Get end-to-end encryption ready before any notes are read or written: unlock with the key
     * remembered on this device or ask for the passphrase, then finish an interrupted switch.
     * Returns false if the user left (signed out) meanwhile.
     */
    const prepareEncryption = async (vault: KeyVault, store: SupabaseStore, uid: string, email: string | null, signOut: () => void) => {
      try {
        await vault.refresh();
      } catch (e) {
        console.warn('Could not check encryption state', e); // offline: the server still refuses plaintext if encryption is on
      }
      if (vault.needsKey && !(await vault.restore())) {
        await new Promise<void>((done) => showScreen({ kind: 'unlock', o: { vault, store, email, signOut }, done }));
        if (current !== uid) return false;
      }
      if (vault.state === 'encrypting' || vault.state === 'decrypting') {
        const finishing = vault.state;
        showBusy(finishing === 'encrypting' ? 'Finishing encrypting your notes...' : 'Finishing decrypting your notes...');
        try {
          await store.convertAll((done, total) => {
            if (total) showBusy(`${finishing === 'encrypting' ? 'Encrypting' : 'Decrypting'} your notes: ${done} of ${total}...`);
          });
          await vault.setState(finishing === 'encrypting' ? 'on' : 'off');
        } catch (e) {
          console.error('Could not finish converting notes', e);
          toast('Some notes are not converted yet; Lineboard will try again next time.', 'error');
        }
      } else if (vault.state === 'off' && vault.hasKeys) {
        // Encryption was turned off; tidy up anything another device still wrote encrypted.
        if (await vault.restore()) void store.sweep().catch((e) => console.warn('Sweep failed', e));
      } else if (vault.state === 'on' && vault.unlocked) {
        // Encrypt anything an older client or another device saved in plaintext meanwhile.
        void store.sweep().catch((e) => console.warn('Sweep failed', e));
      }
      return current === uid;
    };

    const show = async (session: Session | null) => {
      activeSession = session;
      if (recovering) return;
      const page = pageName();
      if (page === 'terms' || page === 'privacy' || page === 'home' || page === 'how-it-works') {
        clearApp();
        current = null;
        if (page === 'terms' || page === 'privacy') showScreen({ kind: 'policy', page });
        else showScreen({ kind: 'home', cloud: true, signedIn: !!session, onStart: () => navigate('/app') });
        return;
      }
      if (!session) {
        if (current === 'guest' || current === null) return; // already on a signed-out screen
        if (current !== undefined && page === 'app') {
          // This device was signed out (from another device, by a password change, or the session ended):
          // back to sign-in, not into guest mode.
          clearApp();
          current = null;
          setGuestActive(false);
          replaceRoute('/login');
          showSignIn();
          return;
        }
        if (page === 'login' || page === 'signup') {
          if (lsGet<boolean>(GUEST_MIGRATE, false)) void showGuestSignIn();
          else showSignIn();
        } else if (page === 'app' || isGuestActive()) startGuest();
        else {
          current = null;
          showScreen({ kind: 'home', cloud: true, signedIn: false, onStart: () => navigate('/app') });
        }
        return;
      }
      const uid = session.user.id;
      if (current === uid) return; // token refresh etc.
      clearApp();
      replaceRoute('/app');
      document.title = 'Lineboard';
      current = uid; // set before awaiting, so repeated auth events don't run this twice
      setGuestActive(false);
      const vault = new KeyVault(sb, uid);
      const store = new SupabaseStore(sb, uid, vault);
      const email = session.user.email ?? null;
      // A saved session may have been signed out from another device meanwhile.
      if ((await account.sessionAlive()) === false) {
        await signedOutRemotely();
        return;
      }
      if (current !== uid) return;
      const signOut = async () => {
        const was = current;
        current = null; // a deliberate sign-out goes to the homepage, not the sign-in page
        const { error } = await sb.auth.signOut();
        if (error) { current = was; toast(error.message, 'error'); return; }
        await vault.lock(); // forget the encryption key on this device
        setGuestActive(false);
        activeSession = null;
        navigate('/home');
      };
      let relocking = false;
      vault.onLocked = () => {
        // Encryption was turned on from another device: ask for the passphrase, then carry on saving.
        if (relocking || current !== uid) return;
        relocking = true;
        clearApp();
        current = undefined;
        void show(activeSession ?? null);
      };
      // Two-step verification: ask for the authenticator code before anything else.
      if (await account.needsSecondStep()) {
        await secondStep(account, () => void signOut());
        if (current !== uid) return;
      }
      if (!(await prepareEncryption(vault, store, uid, email, () => void signOut()))) return;
      await maybeMoveGuestNotes(store, uid);
      if (current !== uid) return; // signed out meanwhile
      const onAccountDeleted = async () => {
        current = null;
        clearApp();
        await vault.lock().catch(() => {}); // forget the encryption key on this device
        // Forget this account's copies on the device: settings, the save queue, last note...
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith('lb-') && k.includes(uid)) localStorage.removeItem(k);
        } catch {
          /* storage unavailable */
        }
        // The session no longer exists on the server; clear it locally.
        await sb.auth.signOut({ scope: 'local' }).catch(() => {});
        setGuestActive(false);
        activeSession = null;
        navigate('/home');
        toast('Your account and all its data have been deleted.');
      };
      app = showApp(new App(store, { id: uid, email }, { signOut, account, onAccountDeleted }));
      // Once per account: record which notes use which pictures, so deleting notes can tidy files up.
      void store.backfillImageUses().catch((e) => console.warn('Picture uses not recorded yet', e));
    };

    window.addEventListener(navigationEvent, () => {
      if (recovering || activeSession === undefined) return;
      clearApp();
      current = undefined;
      void show(activeSession);
    });

    // Whose encryption key may be remembered on this device. However the session ends (signing out
    // here, from another device, a password change, an expired session), the key is forgotten.
    let keyOwner: string | null = null;
    const forgetKeyIfSignedOut = (session: Session | null) => {
      if (!session) {
        // No one is signed in (also when the session ended while the app was closed): no key stays.
        keyOwner = null;
        void forgetAllRememberedKeys().catch(() => {});
        return;
      }
      if (keyOwner && session.user.id !== keyOwner) void forgetRememberedKey(keyOwner).catch(() => {});
      keyOwner = session.user.id;
    };

    sb.auth.onAuthStateChange((event, session) => {
      activeSession = session;
      forgetKeyIfSignedOut(session);
      // Defer: calling Supabase from inside this callback can deadlock the auth lock.
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') {
          recovering = true;
          clearApp();
          current = undefined;
          void (async () => {
            // With two-step verification on, the code is needed before the password can change.
            if (await account.needsSecondStep()) await secondStep(account, () => void sb.auth.signOut());
            showScreen({
              kind: 'new-password',
              sb,
              done: () => {
                recovering = false;
                void show(activeSession ?? session);
              },
            });
          })();
          return;
        }
        if (activeSession !== undefined) void show(activeSession);
      }, 0);
    });
  }
}
