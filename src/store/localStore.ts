import { decodeSnapshot, encodeSnapshot, type SnapStroke, type VersionMeta } from '../history';
import { DEFAULT_NOTEBOOK_NAME, TRASH_NAME, type Flags, type Notebook, type NoteMeta, type Settings, type Stroke } from '../types';
import { lsGet, lsSet, uuid } from '../util';
import { cleanName, EMPTY_PROFILE, type Profile } from '../profile';
import { GoneError, StoreError, type Store } from './store';

/** The trash notebook's id on this device (other notebooks have random ids). */
export const LOCAL_TRASH_ID = 'trash';
import { MAX_SNAPSHOT_BYTES } from '../limits';

/** Images on this device: IndexedDB, since localStorage is far too small for pictures. */
const IMG_DB = 'lineboard-local-images';
function imageDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Image storage unavailable'));
  });
}
async function imageTx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await imageDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction('images', mode).objectStore('images'));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error ?? new Error('Image storage failed'));
    });
  } finally {
    db.close();
  }
}

/** Version history on this device: IndexedDB too (snapshots can be large). */
const HISTORY_DB = 'lineboard-local-history';
type VersionRecord = VersionMeta & { data: Uint8Array<ArrayBuffer> };
function historyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HISTORY_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('versions', { keyPath: 'id' }).createIndex('note_id', 'note_id');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('History storage unavailable'));
  });
}
/** Run `fn` in one transaction on the versions store; resolves with its result once committed. */
async function historyTx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await historyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('versions', mode);
      const r = fn(tx.objectStore('versions'));
      tx.oncomplete = () => resolve((r ? r.result : undefined) as T);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('History storage failed'));
    });
  } finally {
    db.close();
  }
}

/** Device-only storage, used when no Supabase project is configured. */
export class LocalStore implements Store {
  readonly mode = 'local' as const;

  private notes(): NoteMeta[] {
    return lsGet<NoteMeta[]>('lb-local-notes', []).map((n) => ({ ...n, notebook_id: n.notebook_id ?? null }));
  }
  private saveNotes(n: NoteMeta[]) {
    lsSet('lb-local-notes', n);
  }
  private notebooks(): Notebook[] {
    return lsGet<Notebook[]>('lb-local-notebooks', []);
  }
  private saveNotebooks(n: Notebook[]) {
    lsSet('lb-local-notebooks', n);
  }
  private strokesKey(id: string) {
    return 'lb-local-strokes-' + id;
  }
  private touch(noteId: string) {
    const n = this.notes();
    const x = n.find((m) => m.id === noteId);
    if (x) {
      x.updated_at = new Date().toISOString();
      this.saveNotes(n);
    }
  }

  async listNotebooks() {
    return this.notebooks().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async ensureDefaultNotebook() {
    return (await this.listNotebooks()).find((b) => b.id !== this.trashId) ?? this.createNotebook(DEFAULT_NOTEBOOK_NAME);
  }
  async createNotebook(name: string) {
    const now = new Date().toISOString();
    const b: Notebook = { id: uuid(), name, created_at: now, updated_at: now };
    this.saveNotebooks([...this.notebooks(), b]);
    return b;
  }
  async renameNotebook(id: string, name: string) {
    const all = this.notebooks();
    const b = all.find((x) => x.id === id);
    if (!b) throw new GoneError('notebook');
    b.name = name;
    this.saveNotebooks(all);
  }

  readonly trashId = LOCAL_TRASH_ID;
  async ensureTrash(): Promise<Notebook> {
    const found = this.notebooks().find((b) => b.id === this.trashId);
    if (found) return found;
    const now = new Date().toISOString();
    const b: Notebook = { id: this.trashId, name: TRASH_NAME, created_at: now, updated_at: now };
    this.saveNotebooks([...this.notebooks(), b]);
    return b;
  }

  /** A notebook notes can go into: it exists and is not in the trash (the trash itself is fine). */
  private liveNotebook(id: string) {
    const b = this.notebooks().find((x) => x.id === id);
    if (!b || (b.deleted_at && id !== this.trashId)) throw new GoneError('notebook');
  }
  async deleteNotebook(id: string) {
    for (const n of this.notes().filter((m) => m.notebook_id === id)) await this.deleteNote(n.id);
    this.saveNotebooks(this.notebooks().filter((b) => b.id !== id));
  }
  async deleteFromTrash(kind: 'note' | 'notebook', id: string, olderThan?: string) {
    const before = (at?: string | null) => !!at && (!olderThan || at < olderThan);
    if (kind === 'note') {
      const n = this.notes().find((m) => m.id === id);
      if (!n || n.notebook_id !== this.trashId || (olderThan && !before(n.deleted_at))) return false;
      await this.deleteNote(id);
      return true;
    }
    const b = this.notebooks().find((x) => x.id === id);
    if (!b || b.id === this.trashId || !before(b.deleted_at)) return false;
    await this.deleteNotebook(id);
    return true;
  }
  async moveNotes(noteIds: string[], notebookId: string) {
    this.liveNotebook(notebookId);
    const all = this.notes();
    const ids = new Set(noteIds);
    if (all.filter((m) => ids.has(m.id)).length < ids.size) throw new GoneError('note');
    // Into the trash: since when, and no longer starred or archived. Out of it: back in use.
    const toTrash = notebookId === this.trashId;
    const change = toTrash ? { notebook_id: notebookId, deleted_at: new Date().toISOString(), starred: false, archived_at: null } : { notebook_id: notebookId, deleted_at: null };
    this.saveNotes(all.map((m) => (ids.has(m.id) ? { ...m, ...change } : m)));
  }

  async listNotes() {
    return this.notes().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async createNote(title: string, notebookId: string) {
    this.liveNotebook(notebookId);
    const now = new Date().toISOString();
    const m: NoteMeta = { id: uuid(), title, notebook_id: notebookId, created_at: now, updated_at: now };
    this.saveNotes([m, ...this.notes()]);
    return m;
  }
  async renameNote(id: string, title: string) {
    const n = this.notes();
    const x = n.find((m) => m.id === id);
    if (!x) throw new GoneError('note');
    x.title = title;
    this.saveNotes(n);
  }
  async deleteNote(id: string) {
    this.saveNotes(this.notes().filter((m) => m.id !== id));
    await this.deleteVersions((await this.listVersions(id)).map((v) => v.id)).catch(() => {});
    try {
      localStorage.removeItem(this.strokesKey(id));
    } catch {
      /* ignore */
    }
  }
  async loadStrokes(noteId: string) {
    return lsGet<Stroke[]>(this.strokesKey(noteId), []);
  }
  async upsertStrokes(strokes: Stroke[]) {
    const byNote = new Map<string, Stroke[]>();
    for (const s of strokes) byNote.set(s.note_id, [...(byNote.get(s.note_id) ?? []), s]);
    // Ink for a note another tab deleted would be kept by nothing.
    const known = new Set(this.notes().map((m) => m.id));
    if ([...byNote.keys()].some((id) => !known.has(id))) throw new GoneError('note');
    for (const [noteId, list] of byNote) {
      const cur = lsGet<Stroke[]>(this.strokesKey(noteId), []);
      const ids = new Set(list.map((s) => s.id));
      lsSet(this.strokesKey(noteId), [...cur.filter((s) => !ids.has(s.id)), ...list]);
      this.touch(noteId);
    }
  }
  async deleteStrokes(ids: string[]) {
    const set = new Set(ids);
    for (const m of this.notes()) {
      const cur = lsGet<Stroke[]>(this.strokesKey(m.id), []);
      const next = cur.filter((s) => !set.has(s.id));
      if (next.length !== cur.length) {
        lsSet(this.strokesKey(m.id), next);
        this.touch(m.id);
      }
    }
  }
  async putImage(id: string, file: Blob) {
    await imageTx('readwrite', (s) => s.put(file, id));
  }
  async getImage(id: string): Promise<Blob> {
    const b = await imageTx<Blob | undefined>('readonly', (s) => s.get(id));
    if (!b) throw new Error('Image not found on this device');
    return b;
  }

  async loadProfile(): Promise<Profile> {
    const p = lsGet<Partial<Profile>>('lb-local-profile', {});
    return { ...EMPTY_PROFILE, name: cleanName(p.name), picture: typeof p.picture === 'string' ? p.picture : null, pictureType: p.pictureType ?? null };
  }
  async saveProfile(change: { name?: string; picture?: Blob | null }): Promise<Profile> {
    const p = await this.loadProfile();
    if (change.name !== undefined) p.name = cleanName(change.name);
    if (change.picture === null) {
      await imageTx('readwrite', (s) => s.delete('profile-picture')).catch(() => {});
      p.picture = null;
      p.pictureType = null;
    } else if (change.picture) {
      await this.putImage('profile-picture', change.picture);
      p.picture = uuid();
      p.pictureType = change.picture.type;
    }
    lsSet('lb-local-profile', p);
    return p;
  }
  async loadProfilePicture(p: Profile): Promise<Blob | null> {
    if (!p.picture) return null;
    return this.getImage('profile-picture').catch(() => null);
  }

  async setNoteFlags(id: string, flags: Flags) {
    const all = this.notes();
    if (!all.some((m) => m.id === id)) throw new GoneError('note');
    this.saveNotes(all.map((m) => (m.id === id ? { ...m, ...flags } : m)));
  }
  async setNotebookFlags(id: string, flags: Flags) {
    const all = this.notebooks();
    if (!all.some((b) => b.id === id)) throw new GoneError('notebook');
    this.saveNotebooks(all.map((b) => (b.id === id ? { ...b, ...flags } : b)));
  }

  async listVersions(noteId: string): Promise<VersionMeta[]> {
    const rows = await historyTx<VersionRecord[]>('readonly', (s) => s.index('note_id').getAll(noteId));
    return rows.map(({ data: _data, ...meta }) => meta).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async loadVersion(v: VersionMeta): Promise<SnapStroke[]> {
    const r = await historyTx<VersionRecord | undefined>('readonly', (s) => s.get(v.id));
    if (!r) throw new Error('This version is no longer on this device.');
    return decodeSnapshot(r.data);
  }
  async saveVersion(v: VersionMeta, strokes: SnapStroke[]) {
    const data = await encodeSnapshot(strokes);
    if (data.length > MAX_SNAPSHOT_BYTES) throw new StoreError('This note is too large to keep in its version history.', true);
    await historyTx('readwrite', (s) => void s.put({ ...v, data } satisfies VersionRecord));
  }
  async renameVersion(v: VersionMeta, name: string | null) {
    const r = await historyTx<VersionRecord | undefined>('readonly', (s) => s.get(v.id));
    if (r) await historyTx('readwrite', (s) => void s.put({ ...r, name }));
  }
  async deleteVersions(ids: string[]) {
    if (ids.length) await historyTx('readwrite', (s) => void ids.forEach((id) => s.delete(id)));
  }

  /** Remove every note, stroke, image and setting kept on this device. */
  async clearAll() {
    await historyTx('readwrite', (s) => void s.clear());
    // Wait until the pictures are really gone (the transaction has committed): a reload straight
    // after could otherwise abort it and leave the files behind.
    const db = await imageDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Could not remove the pictures'));
      });
    } finally {
      db.close();
    }
    for (const m of this.notes()) {
      try {
        localStorage.removeItem(this.strokesKey(m.id));
      } catch {
        /* ignore */
      }
    }
    for (const k of ['lb-local-notes', 'lb-local-notebooks', 'lb-local-settings', 'lb-local-profile']) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  }

  async loadSettings() {
    return lsGet<Partial<Settings> | null>('lb-local-settings', null);
  }
  async saveSettings(s: Settings) {
    lsSet('lb-local-settings', s);
  }
}
