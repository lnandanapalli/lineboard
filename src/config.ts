declare global {
  interface Window {
    __LINEBOARD_CONFIG__?: { supabaseUrl?: string; supabaseAnonKey?: string; turnstileSiteKey?: string };
  }
}

const runtime = window.__LINEBOARD_CONFIG__ ?? {};

export const config = {
  supabaseUrl: (runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || '').trim(),
  supabaseAnonKey: (runtime.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
  /** Cloudflare Turnstile site key: when set, sign-in, sign-up and resets ask for the bot check (see captcha.ts). */
  turnstileSiteKey: (runtime.turnstileSiteKey || import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim(),
};

export const hasCloud = Boolean(config.supabaseUrl && config.supabaseAnonKey);
