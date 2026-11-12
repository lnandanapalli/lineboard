import { createClient, type Session } from '@supabase/supabase-js';
import './styles.css';
import { App } from './app';
import { renderAuth, renderNewPassword } from './auth';
import { config, hasCloud } from './config';
import { LocalStore } from './store/localStore';
import { SupabaseStore } from './store/supabaseStore';

const root = document.getElementById('app')!;

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

if (!hasCloud) {
  // No backend configured: run fully on this device.
  new App(root, new LocalStore(), { id: 'local', email: null }, null);
} else {
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let app: App | null = null;
  let currentUser: string | null | undefined = undefined; // undefined = nothing rendered yet
  let recovering = false;

  const show = (session: Session | null) => {
    if (recovering) return;
    const uid = session?.user.id ?? null;
    if (uid === currentUser) return; // token refresh etc.
    app?.destroy();
    app = null;
    currentUser = uid;
    if (session) {
      app = new App(root, new SupabaseStore(sb, session.user.id), { id: session.user.id, email: session.user.email ?? null }, async () => {
        await sb.auth.signOut();
      });
    } else {
      renderAuth(root, sb);
    }
  };

  sb.auth.onAuthStateChange((event, session) => {
    // Defer: calling Supabase from inside this callback can deadlock the auth lock.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') {
        recovering = true;
        app?.destroy();
        app = null;
        currentUser = undefined;
        renderNewPassword(root, sb, () => {
          recovering = false;
          show(session);
        });
        return;
      }
      show(session);
    }, 0);
  });
}
