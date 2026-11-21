import { createPortal } from 'react-dom';
import { useState } from 'react';
import { Logo } from './Logo';
import { lsGet, lsSet } from '../util';

/** Asks whether this device's guest notes should join the account just signed in to. */
export function MoveNotesScreen({ count, answer }: { count: number; answer: (a: 'move' | 'keep') => void }) {
  const one = count === 1;
  return (
    <div className="auth-screen">
      <div className="auth-card migrate-card">
        <div className="brand">
          <Logo />
          <span>Notes on this device</span>
        </div>
        <p>
          This browser has {one ? 'a note' : `${count} notes`} made without an account. Add {one ? 'it' : 'them'} to your account?
        </p>
        <div className="migrate-actions">
          <button className="btn primary wide" type="button" onClick={() => answer('move')}>
            Add {one ? 'it' : 'them'} to my account
          </button>
          <button className="btn wide" type="button" onClick={() => answer('keep')}>
            Keep them separate on this device
          </button>
        </div>
      </div>
    </div>
  );
}

/** A message while something finishes before the notes open. */
export function BusyScreen({ text }: { text: string }) {
  return (
    <div className="auth-screen">
      <div className="auth-card migrate-card">
        <div className="brand">
          <Logo />
          <span>Lineboard</span>
        </div>
        <p>{text}</p>
      </div>
    </div>
  );
}

const NOTICE_KEY = 'lb-storage-notice';

/**
 * A one-time notice about what Lineboard keeps in the browser. Everything it stores is strictly
 * necessary for the app to work (notes, settings, the sign-in session, offline files), and there
 * are no advertising, analytics or tracking cookies, so EU/UK rules (ePrivacy art. 5(3)) ask for
 * clear information, not consent. The notice says so and links to the full list in the privacy
 * policy. Dismissing it is remembered in the same storage.
 */
export function StorageNotice() {
  const [seen, setSeen] = useState(() => lsGet<boolean>(NOTICE_KEY, false));
  if (seen) return null;
  return createPortal(
    <section className="storage-notice" role="region" aria-label="Storage notice">
      <p>
        Lineboard keeps your notes, settings and sign-in in this browser so the app works. No ads, no analytics, no tracking cookies. <a href="/privacy#storage">What is stored</a>
      </p>
      <button
        className="btn primary"
        type="button"
        onClick={() => {
          lsSet(NOTICE_KEY, true);
          setSeen(true);
        }}
      >
        OK
      </button>
    </section>,
    document.body,
  );
}
