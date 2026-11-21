import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanStyle, isPlain } from '../textStyle';
import { fromB64, isSealedBytes, open, openBytes, seal, sealBytes, toB64 } from '../crypto/cipher';
import { decodeSnapshot, encodeSnapshot, type SnapStroke, type VersionMeta } from '../history';
import type { KeyVault } from '../crypto/vault';
import { DEFAULT_NOTEBOOK_NAME, type Flags, type Notebook, type NoteMeta, type Settings, type Stroke } from '../types';
import { uuid } from '../util';
import { cleanName, EMPTY_PROFILE, type Profile } from '../profile';
import { MAX_SNAPSHOT_BYTES } from '../limits';
import { StoreError, type Store } from './store';

const PAGE = 1000; // PostgREST default max rows per request
const CHUNK = 200;

interface PgErr {
  message: string;
  code?: string;
}

/** Row-level security refused the row: with encryption on, plaintext notes are rejected. */
const isRlsDenied = (e: PgErr | null) => e?.code === '42501';

function check(error: PgErr | null) {
  if (!error) return;
  // SQLSTATE classes 22 (data), 23 (constraint), 42 (syntax/permission) won't succeed on retry.
  const permanent = !!error.code && /^(22|23|42)/.test(error.code);
  throw new StoreError(readable(error.message || 'Request failed'), permanent);
}

/** The schema's fair-use limits (supabase/schema.sql), in words. */
function readable(message: string): string {
  const limit = /Lineboard limit: (.*)$/.exec(message);
  if (limit) return limit[1].charAt(0).toUpperCase() + limit[1].slice(1) + '.';
  if (/strokes_points_size|strokes_points_count|strokes_enc_size/.test(message)) return 'That stroke is too long to save; draw it in shorter pieces.';
  if (/user_settings_size/.test(message)) return 'Your settings are too large to save.';
  return message;
}

/** Shown when a title or name cannot be decrypted on this device. */
export const LOCKED_TITLE = 'Encrypted';

type StrokeRow = Omit<Stroke, 'tool' | 'color' | 'width' | 'points' | 'text' | 'dash' | 'font'> &
  Partial<Pick<Stroke, 'tool' | 'color' | 'width' | 'points'>> & { enc?: string | null; text?: string | null; dash?: Stroke['dash'] | null; font?: unknown };
type StrokePayload = Pick<Stroke, 'tool' | 'color' | 'width' | 'points' | 'text' | 'dash' | 'font'>;
/** Only a text box's non-default style is kept; null/absent means plain. */
const fontOf = (raw: unknown) => {
  const f = cleanStyle(raw);
  return Object.keys(f).length ? { font: f } : {};
};
type NoteRow = NoteMeta & { title_enc?: string | null };
type BookRow = Notebook & { name_enc?: string | null };

/** Private Storage bucket for images, one folder per user (see supabase/schema.sql). */
const IMAGE_BUCKET = 'images';

function imageError(error: { message?: string; statusCode?: string | number; status?: number } | null): StoreError {
  const msg = error?.message ?? 'Image request failed';
  if (/bucket not found/i.test(msg)) return new StoreError('Images need a database update: the site operator re-runs supabase/schema.sql.', true);
  // The bucket's limits and the per-account quota (supabase/schema.sql).
  if (/exceeded the maximum allowed size|payload too large/i.test(msg)) return new StoreError('That picture is too large (15 MB at most).', true);
  if (/mime type .* not supported|invalid mime/i.test(msg)) return new StoreError('That file type cannot be stored as a picture.', true);
  return new StoreError(msg, false);
}

/** The file is simply not there (as opposed to a network or server failure, which should be retried). */
function isMissing(error: { message?: string; statusCode?: string | number; status?: number }) {
  return String(error.statusCode) === '404' || error.status === 404 || /not.?found/i.test(error.message ?? '');
}

const ctx = {
  image: (id: string) => `image:${id}`,
  stroke: (id: string) => `stroke:${id}`,
  note: (id: string) => `note:${id}`,
  book: (id: string) => `notebook:${id}`,
  version: (id: string) => `version:${id}`,
  versionName: (id: string) => `version-name:${id}`,
};

type VersionRow = Omit<VersionMeta, 'name'> & { name: string | null; name_enc: string | null; data?: string | null; data_enc?: string | null };
const VERSION_COLS = 'id,note_id,created_at,kind,name,name_enc,restored_from';
/** Versions are fetched a few at a time when their content comes along (each can be large). */
const VERSION_PAGE = 20;

/**
 * Cloud storage. With a vault whose encryption is on, note titles, notebook names and ink are
 * encrypted here before they leave the device, and decrypted after loading; the rest of the app
 * never sees ciphertext. Ids, timestamps and which note a stroke belongs to stay readable so
 * syncing and ordering keep working.
 */
export class SupabaseStore implements Store {
  readonly mode = 'cloud' as const;
  constructor(
    private sb: SupabaseClient,
    private userId: string,
    readonly vault?: KeyVault,
  ) {}

  private get encCols() {
    return this.vault?.supported !== false;
  }
  private bookCols() {
    return 'id,name,created_at,updated_at' + (this.encCols ? ',name_enc' : '') + (this.flagCols ? ',starred,archived_at' : '') + (this.trashCols ? ',deleted_at' : '');
  }
  private noteCols() {
    return 'id,title,notebook_id,created_at,updated_at' + (this.encCols ? ',title_enc' : '') + (this.flagCols ? ',starred,archived_at' : '') + (this.trashCols ? ',deleted_at' : '');
  }

  /** Whether the database has the starred / archived_at columns (stars and the archive). */
  private flagCols = false;
  private flagProbe: Promise<boolean> | null = null;
  supportsFlags(): Promise<boolean> {
    this.flagProbe ??= (async () => {
      const { error } = await this.sb.from('notes').select('starred,archived_at').limit(1);
      const missing = !!error && (error.code === '42703' || /starred|archived_at/.test(error.message ?? ''));
      if (error && !missing) this.flagProbe = null; // offline or similar: ask again next time
      this.flagCols = !missing;
      return this.flagCols;
    })();
    return this.flagProbe;
  }
  /** Whether the database has the deleted_at columns (the trash). */
  private trashCols = false;
  private trashProbe: Promise<boolean> | null = null;
  supportsTrash(): Promise<boolean> {
    this.trashProbe ??= (async () => {
      const { error } = await this.sb.from('notes').select('deleted_at').limit(1);
      const missing = !!error && (error.code === '42703' || /deleted_at/.test(error.message ?? ''));
      if (error && !missing) this.trashProbe = null; // offline or similar: ask again next time
      this.trashCols = !missing;
      return this.trashCols;
    })();
    return this.trashProbe;
  }
  /** Both optional column sets, checked once before notes and notebooks are read or written. */
  private probeCols() {
    return Promise.all([this.supportsFlags(), this.supportsTrash()]);
  }
  private flagsOf(r: { starred?: boolean | null; archived_at?: string | null; deleted_at?: string | null }): Flags {
    return { ...(r.starred ? { starred: true } : {}), ...(r.archived_at ? { archived_at: r.archived_at } : {}), ...(r.deleted_at ? { deleted_at: r.deleted_at } : {}) };
  }
  private async writeFlags(table: 'notes' | 'notebooks', id: string, flags: Flags) {
    if ('deleted_at' in flags) {
      if (!(await this.supportsTrash())) throw new StoreError('The trash needs a database update: the site operator re-runs supabase/schema.sql.', true);
    } else if (!(await this.supportsFlags())) throw new StoreError('Stars and the archive need a database update: the site operator re-runs supabase/schema.sql.', true);
    const { error } = await this.sb.from(table).update(flags).eq('id', id);
    check(error);
  }
  setNoteFlags(id: string, flags: Flags) {
    return this.writeFlags('notes', id, flags);
  }
  setNotebookFlags(id: string, flags: Flags) {
    return this.writeFlags('notebooks', id, flags);
  }
  private strokeCols() {
    return 'id,note_id,tool,color,width,points,created_at' + (this.encCols ? ',enc' : '') + (this.textCol ? ',text' : '') + (this.dashCol ? ',dash' : '') + (this.fontCol ? ',font' : '');
  }

  /** Whether the database has the strokes.text column (text boxes); older schemas don't. */
  private textCol = false;
  /** Likewise strokes.dash (dashed and dotted shapes). Without it, shapes are saved solid. */
  private dashCol = false;
  /** Likewise strokes.font (text box font, emphasis, alignment). Without it, text is saved plain. */
  private fontCol = false;
  private textProbe: Promise<boolean> | null = null;
  supportsText(): Promise<boolean> {
    this.textProbe ??= (async () => {
      const { error } = await this.sb.from('strokes').select('text').limit(1);
      this.textCol = !error;
      if (error && error.code !== '42703' && !/text/.test(error.message ?? '')) {
        // Something other than a missing column (offline...): try again next time.
        this.textProbe = null;
        this.textCol = true;
      }
      const { error: de } = await this.sb.from('strokes').select('dash').limit(1);
      this.dashCol = !de || (de.code !== '42703' && !/dash/.test(de.message ?? ''));
      const { error: fe } = await this.sb.from('strokes').select('font').limit(1);
      this.fontCol = !fe || (fe.code !== '42703' && !/font/.test(fe.message ?? ''));
      return this.textCol;
    })();
    return this.textProbe;
  }

  /** The key to encrypt new writes with, or null for plaintext. Throws (retryably) while locked. */
  private async writeKey(): Promise<CryptoKey | null> {
    const v = this.vault;
    if (!v) return null;
    await v.refreshIfStale();
    if (!v.writeEncrypted) return null;
    if (!v.key) {
      v.onLocked();
      throw new StoreError('Encryption is locked on this device', false);
    }
    return v.key;
  }

  /**
   * Run a write. If the server refuses it because encryption was turned on from another device,
   * pick up the new state and try once more (encrypted this time).
   */
  private async write(fn: (key: CryptoKey | null) => Promise<PgErr | null>) {
    let error = await fn(await this.writeKey());
    if (isRlsDenied(error) && this.vault) {
      const before = this.vault.writeEncrypted;
      await this.vault.refresh().catch(() => {});
      if (this.vault.writeEncrypted && !before) error = await fn(await this.writeKey());
    }
    check(error);
  }

  // ----------------------------- encoding -----------------------------

  private async readText(plain: string, sealed: string | null | undefined, context: string): Promise<string> {
    if (!sealed) return plain;
    const key = this.vault?.key;
    if (!key) return LOCKED_TITLE;
    try {
      return await open<string>(key, context, sealed);
    } catch (e) {
      console.warn(e);
      return LOCKED_TITLE;
    }
  }

  private async decodeBook(r: BookRow): Promise<Notebook> {
    return { id: r.id, name: await this.readText(r.name, r.name_enc, ctx.book(r.id)), created_at: r.created_at, updated_at: r.updated_at, ...this.flagsOf(r) };
  }
  private async decodeNote(r: NoteRow): Promise<NoteMeta> {
    return {
      id: r.id,
      title: await this.readText(r.title, r.title_enc, ctx.note(r.id)),
      notebook_id: r.notebook_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ...this.flagsOf(r),
    };
  }
  /** Null when the stroke is encrypted and cannot be read here. */
  private async decodeStroke(r: StrokeRow): Promise<Stroke | null> {
    if (!r.enc) return { id: r.id, note_id: r.note_id, tool: r.tool!, color: r.color!, width: r.width!, points: r.points!, ...(r.text != null ? { text: r.text } : {}), ...(r.dash ? { dash: r.dash } : {}), ...fontOf(r.font), created_at: r.created_at };
    const key = this.vault?.key;
    if (!key) return null;
    try {
      const p = await open<StrokePayload>(key, ctx.stroke(r.id), r.enc);
      return { id: r.id, note_id: r.note_id, tool: p.tool, color: p.color, width: p.width, points: p.points, ...(p.text != null ? { text: p.text } : {}), ...(p.dash ? { dash: p.dash } : {}), ...fontOf(p.font), created_at: r.created_at };
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  private async encodeName(key: CryptoKey | null, id: string, name: string) {
    return key ? { name: '', name_enc: await seal(key, ctx.book(id), name) } : this.encCols ? { name, name_enc: null } : { name };
  }
  private async encodeTitle(key: CryptoKey | null, id: string, title: string) {
    return key ? { title: '', title_enc: await seal(key, ctx.note(id), title) } : this.encCols ? { title, title_enc: null } : { title };
  }
  private async encodeStroke(key: CryptoKey | null, s: Stroke) {
    const base = { id: s.id, note_id: s.note_id, user_id: this.userId, created_at: s.created_at };
    const text = s.tool === 'text' || s.tool === 'image' ? (s.text ?? '') : null;
    const dash = s.dash ?? null;
    const font = s.tool === 'text' && !isPlain(s.font) ? cleanStyle(s.font) : null;
    if (!key)
      return { ...base, tool: s.tool, color: s.color, width: s.width, points: s.points, ...(this.encCols ? { enc: null } : {}), ...(this.textCol ? { text } : {}), ...(this.dashCol ? { dash } : {}), ...(this.fontCol ? { font } : {}) };
    const payload: StrokePayload = { tool: s.tool, color: s.color, width: s.width, points: s.points, ...(text != null ? { text } : {}), ...(dash ? { dash } : {}), ...(font ? { font } : {}) };
    const enc = await seal(key, ctx.stroke(s.id), payload);
    return { ...base, tool: null, color: null, width: null, points: null, enc, ...(this.textCol ? { text: null } : {}), ...(this.dashCol ? { dash: null } : {}), ...(this.fontCol ? { font: null } : {}) };
  }

  // ----------------------------- notebooks -----------------------------

  async listNotebooks(): Promise<Notebook[]> {
    await this.probeCols();
    const { data, error } = await this.sb.from('notebooks').select(this.bookCols()).order('created_at', { ascending: true });
    check(error);
    return Promise.all(((data ?? []) as unknown as BookRow[]).map((r) => this.decodeBook(r)));
  }

  async ensureDefaultNotebook(): Promise<Notebook> {
    const existing = await this.listNotebooks();
    if (existing.length) return existing[0];
    // The default notebook's id is the user's own id, so two devices creating it at once end up with one.
    await this.write(async (key) => {
      const { error } = await this.sb
        .from('notebooks')
        .upsert({ id: this.userId, user_id: this.userId, ...(await this.encodeName(key, this.userId, DEFAULT_NOTEBOOK_NAME)) }, { onConflict: 'id', ignoreDuplicates: true });
      return error;
    });
    return (await this.listNotebooks())[0];
  }

  async createNotebook(name: string): Promise<Notebook> {
    await this.probeCols();
    const id = uuid();
    let row: BookRow | null = null;
    await this.write(async (key) => {
      const { data, error } = await this.sb
        .from('notebooks')
        .insert({ id, user_id: this.userId, ...(await this.encodeName(key, id, name)) })
        .select(this.bookCols())
        .single();
      row = data as unknown as BookRow;
      return error;
    });
    return { ...(await this.decodeBook(row!)), name };
  }

  async renameNotebook(id: string, name: string) {
    await this.write(async (key) => {
      const { error } = await this.sb
        .from('notebooks')
        .update({ ...(await this.encodeName(key, id, name)), updated_at: new Date().toISOString() })
        .eq('id', id);
      return error;
    });
  }

  async deleteNotebook(id: string) {
    const { error } = await this.sb.from('notebooks').delete().eq('id', id);
    check(error);
  }

  /** Insert notebooks keeping their ids (used to move notebooks made without an account). Idempotent. */
  async importNotebooks(notebooks: Notebook[]) {
    if (!notebooks.length) return;
    await this.probeCols();
    await this.write(async (key) => {
      const rows = await Promise.all(
        notebooks.map(async (b) => ({
          id: b.id,
          user_id: this.userId,
          ...(await this.encodeName(key, b.id, b.name)),
          created_at: b.created_at,
          updated_at: b.updated_at,
          ...(this.flagCols ? { starred: !!b.starred, archived_at: b.archived_at ?? null } : {}),
          ...(this.trashCols ? { deleted_at: b.deleted_at ?? null } : {}),
        })),
      );
      const { error } = await this.sb.from('notebooks').upsert(rows, { onConflict: 'id' });
      return error;
    });
  }

  // ----------------------------- notes -----------------------------

  async moveNotes(noteIds: string[], notebookId: string) {
    for (let i = 0; i < noteIds.length; i += CHUNK) {
      const { error } = await this.sb.from('notes').update({ notebook_id: notebookId }).in('id', noteIds.slice(i, i + CHUNK));
      check(error);
    }
  }

  async listNotes(): Promise<NoteMeta[]> {
    await this.probeCols();
    // Page through: the API returns at most 1000 rows per request, and an account may have more notes.
    const rows: NoteRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from('notes').select(this.noteCols()).order('updated_at', { ascending: false }).order('id', { ascending: true }).range(from, from + PAGE - 1);
      check(error);
      const page = (data ?? []) as unknown as NoteRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return Promise.all(rows.map((r) => this.decodeNote(r)));
  }

  async createNote(title: string, notebookId: string): Promise<NoteMeta> {
    await this.probeCols();
    const id = uuid();
    let row: NoteRow | null = null;
    await this.write(async (key) => {
      const { data, error } = await this.sb
        .from('notes')
        .insert({ id, user_id: this.userId, notebook_id: notebookId, ...(await this.encodeTitle(key, id, title)) })
        .select(this.noteCols())
        .single();
      row = data as unknown as NoteRow;
      return error;
    });
    return { ...(await this.decodeNote(row!)), title };
  }

  /** Insert or update notes keeping their ids (used to move notes made without an account). Idempotent. */
  async importNotes(notes: NoteMeta[]) {
    if (!notes.length) return;
    await this.probeCols();
    await this.write(async (key) => {
      const rows = await Promise.all(
        notes.map(async (n) => ({
          id: n.id,
          user_id: this.userId,
          ...(await this.encodeTitle(key, n.id, n.title)),
          notebook_id: n.notebook_id,
          created_at: n.created_at,
          updated_at: n.updated_at,
          ...(this.flagCols ? { starred: !!n.starred, archived_at: n.archived_at ?? null } : {}),
          ...(this.trashCols ? { deleted_at: n.deleted_at ?? null } : {}),
        })),
      );
      const { error } = await this.sb.from('notes').upsert(rows, { onConflict: 'id' });
      return error;
    });
  }

  async renameNote(id: string, title: string) {
    await this.write(async (key) => {
      const { error } = await this.sb.from('notes').update(await this.encodeTitle(key, id, title)).eq('id', id);
      return error;
    });
  }

  async deleteNote(id: string) {
    const { error } = await this.sb.from('notes').delete().eq('id', id);
    check(error);
  }

  // ----------------------------- strokes -----------------------------

  async loadStrokes(noteId: string): Promise<Stroke[]> {
    await this.supportsText();
    const rows: StrokeRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb
        .from('strokes')
        .select(this.strokeCols())
        .eq('note_id', noteId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      check(error);
      const page = (data ?? []) as unknown as StrokeRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    const out = await Promise.all(rows.map((r) => this.decodeStroke(r)));
    const unreadable = out.filter((s) => !s).length;
    if (unreadable) console.warn(`${unreadable} encrypted strokes could not be read on this device`);
    return out.filter((s): s is Stroke => !!s);
  }

  async upsertStrokes(strokes: Stroke[]) {
    await this.supportsText();
    for (let i = 0; i < strokes.length; i += CHUNK) {
      const chunk = strokes.slice(i, i + CHUNK);
      await this.write(async (key) => {
        const rows = await Promise.all(chunk.map((s) => this.encodeStroke(key, s)));
        const { error } = await this.sb.from('strokes').upsert(rows, { onConflict: 'id' });
        return error;
      });
    }
  }

  async deleteStrokes(ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await this.sb.from('strokes').delete().in('id', ids.slice(i, i + CHUNK));
      check(error);
    }
  }

  // ----------------------------- profile -----------------------------
  // The display name lives in the account's user metadata (like the email, it is account
  // information, readable by the operator). The picture is a file in the account's picture folder,
  // encrypted like the other pictures when encryption is on.

  private static PICTURE_ID = 'profile-picture';

  async loadProfile(): Promise<Profile> {
    const { data, error } = await this.sb.auth.getUser();
    if (error || !data.user) return { ...EMPTY_PROFILE };
    const m = (data.user.user_metadata ?? {}) as { display_name?: unknown; picture?: unknown; picture_type?: unknown };
    return { name: cleanName(m.display_name), picture: typeof m.picture === 'string' ? m.picture : null, pictureType: typeof m.picture_type === 'string' ? m.picture_type : null };
  }

  async saveProfile(change: { name?: string; picture?: Blob | null }): Promise<Profile> {
    const data: Record<string, unknown> = {};
    if (change.name !== undefined) data.display_name = cleanName(change.name);
    if (change.picture === null) {
      const { error } = await this.sb.storage.from(IMAGE_BUCKET).remove([this.imagePath(SupabaseStore.PICTURE_ID)]);
      if (error && !isMissing(error)) throw imageError(error);
      Object.assign(data, { picture: null, picture_type: null });
    } else if (change.picture) {
      await this.putImage(SupabaseStore.PICTURE_ID, change.picture);
      Object.assign(data, { picture: uuid(), picture_type: change.picture.type });
    }
    const { error } = await this.sb.auth.updateUser({ data });
    if (error) throw new StoreError(error.message, false);
    return this.loadProfile();
  }

  async loadProfilePicture(p: Profile): Promise<Blob | null> {
    if (!p.picture) return null;
    return this.getImage(SupabaseStore.PICTURE_ID, p.pictureType ?? 'image/jpeg').catch(() => null);
  }

  // ----------------------------- version history -----------------------------

  private historyProbe: Promise<boolean> | null = null;
  supportsHistory(): Promise<boolean> {
    this.historyProbe ??= (async () => {
      const { error } = await this.sb.from('note_versions').select('id').limit(1);
      if (!error) return true;
      const missing = error.code === '42P01' || error.code === 'PGRST205' || /note_versions/.test(error.message ?? '');
      if (!missing) this.historyProbe = null; // offline or similar: ask again next time
      return !missing;
    })();
    return this.historyProbe;
  }

  private async decodeVersion(r: VersionRow): Promise<VersionMeta> {
    const name = r.name_enc ? await this.readText('', r.name_enc, ctx.versionName(r.id)) : r.name;
    return { id: r.id, note_id: r.note_id, created_at: r.created_at, kind: r.kind, name: name || null, restored_from: r.restored_from };
  }

  async listVersions(noteId: string): Promise<VersionMeta[]> {
    const rows: VersionRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from('note_versions').select(VERSION_COLS).eq('note_id', noteId).order('created_at', { ascending: false }).range(from, from + PAGE - 1);
      check(error);
      const page = (data ?? []) as unknown as VersionRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return Promise.all(rows.map((r) => this.decodeVersion(r)));
  }

  /** A version's snapshot bytes (deflated JSON), decrypted when needed. */
  private async versionBytes(r: Pick<VersionRow, 'id' | 'data' | 'data_enc'>): Promise<Uint8Array<ArrayBuffer>> {
    if (!r.data_enc) return fromB64(r.data ?? '');
    const key = this.vault?.key;
    if (!key) throw new StoreError('This version is encrypted; unlock encryption to see it', false);
    return openBytes(key, ctx.version(r.id), fromB64(r.data_enc));
  }

  async loadVersion(v: VersionMeta): Promise<SnapStroke[]> {
    const { data, error } = await this.sb.from('note_versions').select('id,data,data_enc').eq('id', v.id).maybeSingle();
    check(error);
    if (!data) throw new StoreError('This version no longer exists.', true);
    return decodeSnapshot(await this.versionBytes(data as VersionRow));
  }

  private async encodeVersion(key: CryptoKey | null, v: VersionMeta, bytes: Uint8Array<ArrayBuffer>): Promise<Record<string, unknown>> {
    const name: { name: string | null; name_enc: string | null } = v.name ? (key ? { name: null, name_enc: await seal(key, ctx.versionName(v.id), v.name) } : { name: v.name, name_enc: null }) : { name: null, name_enc: null };
    const payload: { data: string | null; data_enc: string | null } = key ? { data: null, data_enc: toB64(await sealBytes(key, ctx.version(v.id), bytes)) } : { data: toB64(bytes), data_enc: null };
    const size = (payload.data ?? payload.data_enc ?? '').length;
    return { id: v.id, note_id: v.note_id, user_id: this.userId, created_at: v.created_at, kind: v.kind, restored_from: v.restored_from, ...name, ...payload, size };
  }

  async saveVersion(v: VersionMeta, strokes: SnapStroke[]) {
    const bytes = await encodeSnapshot(strokes);
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new StoreError('This note is too large to keep in its version history.', true);
    await this.write(async (key) => {
      const { error } = await this.sb.from('note_versions').upsert(await this.encodeVersion(key, v, bytes), { onConflict: 'id' });
      return error;
    });
  }

  async renameVersion(v: VersionMeta, name: string | null) {
    await this.write(async (key) => {
      const patch = name ? (key ? { name: null, name_enc: await seal(key, ctx.versionName(v.id), name) } : { name, name_enc: null }) : { name: null, name_enc: null };
      const { error } = await this.sb.from('note_versions').update(patch).eq('id', v.id);
      return error;
    });
  }

  async deleteVersions(ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await this.sb.from('note_versions').delete().in('id', ids.slice(i, i + CHUNK));
      check(error);
    }
  }

  /** Bring versions in line with the account's encryption (one note's, or every remaining one). */
  private async convertVersions(target: CryptoKey | null, encrypting: boolean, noteId: string | null) {
    if (!(await this.supportsHistory())) return;
    let skip = 0; // versions that cannot be decrypted stay as they are
    for (;;) {
      let q = this.sb.from('note_versions').select(VERSION_COLS + ',data,data_enc');
      if (noteId) q = q.eq('note_id', noteId);
      q = encrypting ? q.is('data_enc', null) : q.not('data_enc', 'is', null);
      const { data, error } = await q.order('id', { ascending: true }).range(skip, skip + VERSION_PAGE - 1);
      check(error);
      const rows = (data ?? []) as unknown as VersionRow[];
      if (!rows.length) return;
      for (const r of rows) {
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = await this.versionBytes(r);
        } catch (e) {
          console.warn(e);
          skip++;
          continue;
        }
        const meta = await this.decodeVersion(r);
        if (meta.name === LOCKED_TITLE && r.name_enc && !encrypting) {
          skip++;
          continue;
        }
        const { error: ue } = await this.sb.from('note_versions').upsert(await this.encodeVersion(target, meta, bytes), { onConflict: 'id' });
        check(ue);
      }
      if (rows.length < VERSION_PAGE) return;
    }
  }

  // ----------------------------- images -----------------------------

  private imagePath(id: string) {
    return `${this.userId}/${id}`;
  }

  /** Upload an image. With encryption on, only ciphertext leaves the device. */
  async putImage(id: string, file: Blob) {
    // Storage cannot tell ciphertext from plaintext, so (unlike stroke rows) a stale "off" would not be
    // refused there: check the account's state with the server before sending a file unencrypted.
    if (this.vault && !this.vault.writeEncrypted) await this.vault.refresh();
    const key = await this.writeKey();
    // Raw bytes with an explicit type (a Blob would be sent as a multipart form).
    await this.storeImage(id, new Uint8Array(await file.arrayBuffer()), file.type, key);
  }

  async getImage(id: string, type = 'image/png'): Promise<Blob> {
    const { data, error } = await this.sb.storage.from(IMAGE_BUCKET).download(this.imagePath(id));
    if (error || !data) throw imageError(error);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const sealed = isSealedBytes(bytes);
    const key = this.vault?.key;
    if (sealed && !key) throw new StoreError('This image is encrypted; unlock encryption to see it', false);
    const plain = sealed ? await openBytes(key!, ctx.image(id), bytes) : bytes;
    // A file in the wrong form (uploaded by a device that had not yet noticed encryption changing)
    // is put right the first time it is opened.
    if (key && this.vault && sealed !== this.vault.writeEncrypted) void this.storeImage(id, plain, type, this.vault.writeEncrypted ? key : null).catch(() => {});
    return new Blob([plain], { type });
  }

  /** Upload plaintext bytes, sealing them first when a key is given. */
  private async storeImage(id: string, bytes: Uint8Array<ArrayBuffer>, type: string, key: CryptoKey | null) {
    const body = key ? await sealBytes(key, ctx.image(id), bytes) : bytes;
    const contentType = key ? 'application/octet-stream' : type || 'application/octet-stream';
    const { error } = await this.sb.storage.from(IMAGE_BUCKET).upload(this.imagePath(id), body.buffer, { upsert: true, contentType });
    if (error && /row-level security/i.test(error.message ?? '')) {
      // Refused by the storage policy: the per-account quota, or this device lost access.
      const { data: roomLeft } = await this.sb.rpc('image_quota_ok');
      if (roomLeft === false) throw new StoreError('Your picture storage is full (5000 pictures or 2 GB). Delete some pictures to add more.', true);
    }
    if (error) throw imageError(error);
  }


  /** Re-upload an image encrypted or decrypted, to match the account (used by convertAll). */
  private async convertImage(s: Stroke, encrypt: boolean) {
    const id = s.text;
    const key = this.vault?.key;
    if (!id || !key) return;
    const { data, error } = await this.sb.storage.from(IMAGE_BUCKET).download(this.imagePath(id));
    if (error && isMissing(error)) return; // the file is gone: nothing to convert
    // Any other failure stops the pass before the stroke row is converted, so it is retried later.
    if (error || !data) throw imageError(error);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const sealed = isSealedBytes(bytes);
    if (sealed === encrypt) return;
    const plain = sealed ? await openBytes(key, ctx.image(id), bytes) : bytes;
    await this.storeImage(id, plain, s.color || 'image/png', encrypt ? key : null);
  }

  // ----------------------------- settings -----------------------------

  async loadSettings(): Promise<Partial<Settings> | null> {
    const { data, error } = await this.sb.from('user_settings').select('settings').maybeSingle();
    check(error);
    return (data?.settings as Partial<Settings>) ?? null;
  }

  async saveSettings(s: Settings) {
    const { error } = await this.sb
      .from('user_settings')
      .upsert({ user_id: this.userId, settings: s, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    check(error);
  }

  // ----------------------------- turning encryption on / off -----------------------------

  /**
   * Bring every notebook, note and stroke in line with the vault: encrypt what is still plaintext
   * while encryption is on (or being turned on), decrypt what is encrypted while it is being turned
   * off. Safe to interrupt and run again: each pass only touches rows that still need it.
   * Note dates are kept, so the note list keeps its order.
   */
  async convertAll(onProgress: (done: number, total: number) => void = () => {}) {
    const vault = this.vault;
    if (!vault?.key) throw new Error('Unlock encryption first');
    const key = vault.key;
    const encrypting = vault.writeEncrypted;
    const needs = (sealed: string | null | undefined) => (encrypting ? !sealed : !!sealed);
    const target = encrypting ? key : null;

    const { data: books, error: be } = await this.sb.from('notebooks').select(this.bookCols());
    check(be);
    for (const r of (books ?? []) as unknown as BookRow[]) {
      if (!needs(r.name_enc)) continue;
      const b = await this.decodeBook(r);
      if (!encrypting && b.name === LOCKED_TITLE) continue; // unreadable: leave it encrypted
      const { error } = await this.sb.from('notebooks').update(await this.encodeName(target, b.id, b.name)).eq('id', b.id);
      check(error);
    }

    const { data: notes, error: ne } = await this.sb.from('notes').select(this.noteCols());
    check(ne);
    const list = (notes ?? []) as unknown as NoteRow[];
    onProgress(0, list.length);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      // Title first: the server only accepts strokes into notes that are already in the right form.
      if (needs(r.title_enc)) {
        const n = await this.decodeNote(r);
        if (encrypting || n.title !== LOCKED_TITLE) {
          const { error } = await this.sb.from('notes').update(await this.encodeTitle(target, n.id, n.title)).eq('id', n.id);
          check(error);
        }
      }
      const changed = await this.convertStrokes(target, encrypting, r.id);
      await this.convertVersions(target, encrypting, r.id);
      // Saving strokes bumps the note's date; put the original back.
      if (changed) {
        const { error } = await this.sb.from('notes').update({ updated_at: r.updated_at }).eq('id', r.id);
        check(error);
      }
      onProgress(i + 1, list.length);
    }
    // Anything written meanwhile by another device (notes made after the list above was read).
    await this.convertStrokes(target, encrypting, null);
    await this.convertVersions(target, encrypting, null);
    await this.convertProfilePicture(encrypting);
  }

  /** The profile picture is a picture no stroke points at: bring it in line with the account too. */
  private async convertProfilePicture(encrypt: boolean) {
    const p = await this.loadProfile();
    if (p.picture) await this.convertImage({ text: SupabaseStore.PICTURE_ID, color: p.pictureType ?? 'image/jpeg' } as Stroke, encrypt);
  }

  /**
   * A quick pass over rows that are in the wrong form, without the per-note walk: catches stragglers
   * saved by another device or an older version of the app. A few requests when there is nothing to do.
   */
  async sweep() {
    const key = this.vault?.key;
    if (!key || !this.vault) return;
    const encrypting = this.vault.writeEncrypted;
    const target = encrypting ? key : null;
    const pick = <T extends { is: (c: string, v: null) => T; not: (c: string, op: string, v: null) => T }>(q: T, col: string) =>
      encrypting ? q.is(col, null) : q.not(col, 'is', null);

    const { data: books, error: be } = await pick(this.sb.from('notebooks').select(this.bookCols()), 'name_enc');
    check(be);
    for (const r of (books ?? []) as unknown as BookRow[]) {
      const b = await this.decodeBook(r);
      if (!encrypting && b.name === LOCKED_TITLE) continue;
      const { error } = await this.sb.from('notebooks').update(await this.encodeName(target, b.id, b.name)).eq('id', b.id);
      check(error);
    }
    const { data: notes, error: ne } = await pick(this.sb.from('notes').select(this.noteCols()), 'title_enc');
    check(ne);
    for (const r of (notes ?? []) as unknown as NoteRow[]) {
      const n = await this.decodeNote(r);
      if (!encrypting && n.title === LOCKED_TITLE) continue;
      const { error } = await this.sb.from('notes').update(await this.encodeTitle(target, n.id, n.title)).eq('id', n.id);
      check(error);
    }
    await this.convertStrokes(target, encrypting, null);
    await this.convertVersions(target, encrypting, null);
    await this.convertProfilePicture(encrypting);
  }

  /** Convert one note's strokes (or every remaining one, with noteId null). Returns how many changed. */
  private async convertStrokes(target: CryptoKey | null, encrypting: boolean, noteId: string | null) {
    await this.supportsText();
    let changed = 0;
    let skip = 0; // rows that cannot be decrypted stay as they are
    for (;;) {
      let q = this.sb.from('strokes').select(this.strokeCols());
      if (noteId) q = q.eq('note_id', noteId);
      q = encrypting ? q.is('enc', null) : q.not('enc', 'is', null);
      const { data, error } = await q.order('id', { ascending: true }).range(skip, skip + PAGE - 1);
      check(error);
      const rows = (data ?? []) as unknown as StrokeRow[];
      if (!rows.length) return changed;
      const decoded = await Promise.all(rows.map((r) => this.decodeStroke(r)));
      const ok = decoded.filter((s): s is Stroke => !!s);
      for (const st of ok) if (st.tool === 'image') await this.convertImage(st, encrypting);
      skip += rows.length - ok.length;
      for (let i = 0; i < ok.length; i += CHUNK) {
        const out = await Promise.all(ok.slice(i, i + CHUNK).map((s) => this.encodeStroke(target, s)));
        const { error: ue } = await this.sb.from('strokes').upsert(out, { onConflict: 'id' });
        check(ue);
      }
      changed += ok.length;
      if (rows.length < PAGE) return changed;
    }
  }

  /** Delete every notebook (and so every note and stroke) in the account. Used to start over after losing the keys. */
  async deleteEverything() {
    const { error } = await this.sb.from('notebooks').delete().eq('user_id', this.userId);
    check(error);
    const { error: ne } = await this.sb.from('notes').delete().eq('user_id', this.userId);
    check(ne);
  }
}
