import type { LocalStore } from './store/localStore';
import type { SupabaseStore } from './store/supabaseStore';
import { DEFAULT_SETTINGS, type NoteMeta, type Settings } from './types';
import { lsDel, lsGet, lsSet } from './util';

/**
 * "Try it without an account": a guest uses the device-only LocalStore (the same storage as
 * local mode). When they sign in, their notes are copied into the account and removed here.
 */

/** Set while someone is trying the app without an account, so a reload reopens their notes. */
export const GUEST_ACTIVE = 'lb-guest-active';
/** Set when a guest pressed "Sign in to save": migrate without asking after sign-in. */
export const GUEST_MIGRATE = 'lb-guest-migrate';
/** Per user: they chose to keep this device's notes separate, so don't ask again. */
export const keepSeparateKey = (uid: string) => `lb-guest-keep-${uid}`;

/** App keys the guest session uses (App namespaces them by user id, which is "local" here). */
const GUEST_APP_KEYS = ['lb-settings-local', 'lb-queue-local', 'lb-last-note-local', 'lb-last-notebook-local'];

export const isGuestActive = () => lsGet<boolean>(GUEST_ACTIVE, false);
export const setGuestActive = (on: boolean) => (on ? lsSet(GUEST_ACTIVE, true) : lsDel(GUEST_ACTIVE));

/** Notes on this device that have ink in them (empty notes are not worth moving). */
export async function guestNotesWithInk(local: LocalStore): Promise<NoteMeta[]> {
  const out: NoteMeta[] = [];
  for (const n of await local.listNotes()) {
    if ((await local.loadStrokes(n.id)).length) out.push(n);
  }
  return out;
}

/** Remove everything the guest session stored on this device. */
export function clearGuestData(local: LocalStore) {
  local.clearAll();
  for (const k of GUEST_APP_KEYS) lsDel(k);
  lsDel(GUEST_MIGRATE);
}

/**
 * Copy the guest's notes, strokes and settings into the signed-in account, then clear them here.
 * Ids are kept, so if this is interrupted (or two tabs run it at once) running it again is safe.
 * Throws on failure and leaves the local copy untouched.
 */
export async function migrateGuestData(local: LocalStore, cloud: SupabaseStore, uid: string): Promise<number> {
  const notes = (await guestNotesWithInk(local)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  // Notebooks: reuse an account notebook with the same name (so there is one "My Notebook", not two),
  // otherwise bring the guest's notebook across with its id.
  const cloudBooks = await cloud.listNotebooks();
  const localBooks = await local.listNotebooks();
  const used = new Set(notes.map((n) => n.notebook_id));
  const bookMap = new Map<string, string>();
  for (const b of localBooks.filter((b) => used.has(b.id))) {
    const same = cloudBooks.find((c) => c.name.trim().toLowerCase() === b.name.trim().toLowerCase());
    if (same) bookMap.set(b.id, same.id);
    else {
      await cloud.importNotebooks([b]);
      bookMap.set(b.id, b.id);
    }
  }

  for (const n of notes) {
    // Notes without a (known) notebook stay unassigned; the app files them into the default notebook.
    await cloud.importNotes([{ ...n, notebook_id: (n.notebook_id && bookMap.get(n.notebook_id)) || null }]);
    await cloud.upsertStrokes(await local.loadStrokes(n.id));
  }

  // Carry the guest's settings (stylus calibration, strip height...) over if the account has none yet.
  const localSettings = (await local.loadSettings()) ?? lsGet<Partial<Settings> | null>('lb-settings-local', null);
  if (localSettings && !(await cloud.loadSettings())) {
    await cloud.saveSettings({ ...DEFAULT_SETTINGS, ...localSettings });
  }

  // Reopen the note they were working on.
  const last = lsGet<string | null>('lb-last-note-local', null);
  if (last && notes.some((n) => n.id === last)) lsSet(`lb-last-note-${uid}`, last);
  const lastBook = lsGet<string | null>('lb-last-notebook-local', null);
  if (lastBook && bookMap.has(lastBook)) lsSet(`lb-last-notebook-${uid}`, bookMap.get(lastBook));

  clearGuestData(local);
  return notes.length;
}
