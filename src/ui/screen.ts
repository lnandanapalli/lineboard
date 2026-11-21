import { create } from 'zustand';
import { flushSync } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { App } from '../app';

/**
 * The screen React shows (main.tsx). Null while a screen not yet converted to React renders itself
 * into the host element instead (see boot.ts).
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
  /** The notes app itself. */
  | { kind: 'app'; app: App };

export const useScreen = create<{ screen: Screen | null; seq: number }>(() => ({ screen: null, seq: 0 }));

/**
 * Show a React screen (a fresh one each time, so its state starts over), or none. The page changes
 * at once, as it did when screens drew themselves: what follows (a message, the board measuring
 * itself) finds the new screen, not the old one.
 */
export function showScreen(screen: Screen | null) {
  flushSync(() => useScreen.setState((s) => ({ screen, seq: s.seq + 1 })));
}
