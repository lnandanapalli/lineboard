import { create } from 'zustand';
import { flushSync } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Factor } from '@supabase/supabase-js';
import type { App } from '../app';
import type { AccountSecurity } from '../account';
import type { UnlockOptions } from './Encryption';

/**
 * The screen React shows (main.tsx). Null only before boot.ts shows the first one.
 */
export type Screen =
  | { kind: 'home'; cloud: boolean; signedIn: boolean; onStart: () => void }
  | { kind: 'policy'; page: 'terms' | 'privacy' }
  | {
      kind: 'auth';
      sb: SupabaseClient;
      initialMode: 'signin' | 'signup';
      onTryLocal?: () => void;
      guest?: { noteCount: number; onBack: () => void };
    }
  | { kind: 'new-password'; sb: SupabaseClient; done: () => void }
  /** Someone signed in on a device with notes made without an account: add them, or keep them apart? */
  | { kind: 'move-notes'; count: number; answer: (a: 'move' | 'keep') => void }
  /** A moment of work before the notes open (moving notes, finishing encryption). */
  | { kind: 'busy'; text: string }
  /** Encrypted notes: the passphrase (or recovery key) unlocks them on this device. */
  | { kind: 'unlock'; o: UnlockOptions; done: () => void }
  /** Two-step verification: the code from the authenticator app, after signing in. */
  | { kind: 'second-step'; account: AccountSecurity; factors: Factor[]; signOut: () => void; done: () => void }
  /** The notes app itself. */
  | { kind: 'app'; app: App };

export const useScreen = create<{ screen: Screen | null; seq: number }>(() => ({ screen: null, seq: 0 }));

/**
 * Show a screen (a fresh one each time, so its state starts over). The page changes
 * at once, as it did when screens drew themselves: what follows (a message, the board measuring
 * itself) finds the new screen, not the old one.
 */
export function showScreen(screen: Screen) {
  flushSync(() => useScreen.setState((s) => ({ screen, seq: s.seq + 1 })));
}
