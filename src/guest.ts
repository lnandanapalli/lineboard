import type { LocalStore } from './store/localStore';
import type { SupabaseStore } from './store/supabaseStore';
import { withDefaults, type NoteMeta, type Settings, type Stroke } from './types';
import { SyncQueue } from './sync';
import type { VersionMeta } from './history';
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

function requireSavedGuestChanges() {
  if (SyncQueue.hasPersistedChanges('lb-queue-local')) throw new Error('Guest changes are still waiting to save.');
}

export const isGuestActive = () => lsGet<boolean>(GUEST_ACTIVE, false);
export const setGuestActive = (on: boolean) => (on ? lsSet(GUEST_ACTIVE, true) : lsDel(GUEST_ACTIVE));

/**
 * Notes on this device worth moving: those with ink, or with a version history (a note erased to
 * empty can still hold named versions). Untouched empty notes are left behind.
 */
export async function guestNotesWithInk(local: LocalStore): Promise<NoteMeta[]> {
  const out: NoteMeta[] = [];
  // What is in the trash stays behind (a notebook in the trash takes its notes with it).
  const binned = new Set((await local.listNotebooks()).filter((b) => b.deleted_at || b.id === local.trashId).map((b) => b.id));
  for (const n of await local.listNotes()) {
    if (binned.has(n.notebook_id ?? '')) continue;
    if ((await local.loadStrokes(n.id)).length || (await local.listVersions(n.id).catch(() => [])).length) out.push(n);
  }
  return out;
}

/**
 * Copy the guest's notes, strokes and settings into the signed-in account, then clear them here.
 * Ids are kept, so if this is interrupted (or two tabs run it at once) running it again is safe.
 * Throws on failure and leaves the local copy untouched.
 */
export async function migrateGuestData(local: LocalStore, cloud: SupabaseStore, uid: string): Promise<number> {
  const move = () => copyGuestData(local, cloud, uid);
  return navigator.locks ? navigator.locks.request('lb-guest-migration', move) : move();
}

async function copyGuestData(local: LocalStore, cloud: SupabaseStore, uid: string): Promise<number> {
  requireSavedGuestChanges();
  const notes = (await guestNotesWithInk(local)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  if (!notes.length) return 0;

  // Notebooks: reuse an account notebook with the same name (so there is one "My Notebook", not two),
  // otherwise bring the guest's notebook across with its id.
  // Only notebooks in use: never the account's trash, or one in it.
  const cloudBooks = (await cloud.listNotebooks()).filter((b) => b.id !== cloud.trashId && !b.deleted_at);
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

  const copied: { note: NoteMeta; strokes: Stroke[]; versions: VersionMeta[] }[] = [];
  for (const n of notes) {
    const versions = await local.listVersions(n.id);
    if (versions.length && !(await cloud.supportsHistory())) throw new Error('The account cannot save version history yet.');
    // Notes without a (known) notebook stay unassigned; the app files them into the default notebook.
    await cloud.importNotes([{ ...n, notebook_id: (n.notebook_id && bookMap.get(n.notebook_id)) || null }]);
    const strokes = await local.loadStrokes(n.id);
    // Pictures go to the account's image storage first, so the strokes never point at nothing.
    for (const st of strokes) if (st.tool === 'image' && st.text) await cloud.putImage(st.text, await local.getImage(st.text));
    await cloud.upsertStrokes(strokes);
    // Version history comes along (same ids, so a second run overwrites rather than duplicates).
    // Move pictures used only by old versions before saving those versions.
    for (const v of versions) {
      const snap = await local.loadVersion(v);
      for (const st of snap) if (st.tool === 'image' && st.text && !strokes.some((x) => x.text === st.text)) await cloud.putImage(st.text, await local.getImage(st.text));
      await cloud.saveVersion(v, snap);
    }
    copied.push({ note: n, strokes, versions });
  }

  // Carry the guest's settings (stylus calibration, strip height...) over if the account has none yet.
  const localSettings = (await local.loadSettings()) ?? lsGet<Partial<Settings> | null>('lb-settings-local', null);
  if (localSettings && !(await cloud.loadSettings())) {
    await cloud.saveSettings(withDefaults(localSettings));
  }

  // Reopen the note they were working on.
  const last = lsGet<string | null>('lb-last-note-local', null);
  if (last && notes.some((n) => n.id === last)) lsSet(`lb-last-note-${uid}`, last);
  const lastBook = lsGet<string | null>('lb-last-notebook-local', null);
  if (lastBook && bookMap.has(lastBook)) lsSet(`lb-last-notebook-${uid}`, bookMap.get(lastBook));

  await local.removeMigratedNotes(copied, requireSavedGuestChanges);
  lsDel(GUEST_MIGRATE);
  return notes.length;
}
