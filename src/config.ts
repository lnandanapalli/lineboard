declare global {
  interface Window {
    __LINEBOARD_CONFIG__?: { supabaseUrl?: string; supabaseAnonKey?: string };
  }
}

const runtime = window.__LINEBOARD_CONFIG__ ?? {};

export const config = {
  supabaseUrl: (runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || '').trim(),
  supabaseAnonKey: (runtime.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
};

export const hasCloud = Boolean(config.supabaseUrl && config.supabaseAnonKey);
