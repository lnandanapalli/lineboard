import type { SupabaseClient } from '@supabase/supabase-js';
import { open, seal } from '../crypto/cipher';
import type { KeyVault } from '../crypto/vault';
import { DEFAULT_NOTEBOOK_NAME, type Notebook, type NoteMeta, type Settings, type Stroke } from '../types';
import { uuid } from '../util';
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
  throw new StoreError(error.message || 'Request failed', permanent);
}

/** Shown when a title or name cannot be decrypted on this device. */
export const LOCKED_TITLE = 'Encrypted';

type StrokeRow = Omit<Stroke, 'tool' | 'color' | 'width' | 'points'> & Partial<Pick<Stroke, 'tool' | 'color' | 'width' | 'points'>> & { enc?: string | null };
type NoteRow = NoteMeta & { title_enc?: string | null };
type BookRow = Notebook & { name_enc?: string | null };

const ctx = {
  stroke: (id: string) => `stroke:${id}`,
  note: (id: string) => `note:${id}`,
  book: (id: string) => `notebook:${id}`,
};

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
    return 'id,name,created_at,updated_at' + (this.encCols ? ',name_enc' : '');
  }
  private noteCols() {
    return 'id,title,notebook_id,created_at,updated_at' + (this.encCols ? ',title_enc' : '');
  }
  private strokeCols() {
    return 'id,note_id,tool,color,width,points,created_at' + (this.encCols ? ',enc' : '');
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
    return { id: r.id, name: await this.readText(r.name, r.name_enc, ctx.book(r.id)), created_at: r.created_at, updated_at: r.updated_at };
  }
  private async decodeNote(r: NoteRow): Promise<NoteMeta> {
    return {
      id: r.id,
      title: await this.readText(r.title, r.title_enc, ctx.note(r.id)),
      notebook_id: r.notebook_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
  /** Null when the stroke is encrypted and cannot be read here. */
  private async decodeStroke(r: StrokeRow): Promise<Stroke | null> {
    if (!r.enc) return { id: r.id, note_id: r.note_id, tool: r.tool!, color: r.color!, width: r.width!, points: r.points!, created_at: r.created_at };
    const key = this.vault?.key;
    if (!key) return null;
    try {
      const p = await open<Pick<Stroke, 'tool' | 'color' | 'width' | 'points'>>(key, ctx.stroke(r.id), r.enc);
      return { id: r.id, note_id: r.note_id, tool: p.tool, color: p.color, width: p.width, points: p.points, created_at: r.created_at };
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
    if (!key) return { ...base, tool: s.tool, color: s.color, width: s.width, points: s.points, ...(this.encCols ? { enc: null } : {}) };
    const enc = await seal(key, ctx.stroke(s.id), { tool: s.tool, color: s.color, width: s.width, points: s.points });
    return { ...base, tool: null, color: null, width: null, points: null, enc };
  }

  // ----------------------------- notebooks -----------------------------

  async listNotebooks(): Promise<Notebook[]> {
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
    await this.write(async (key) => {
      const rows = await Promise.all(
        notebooks.map(async (b) => ({
          id: b.id,
          user_id: this.userId,
          ...(await this.encodeName(key, b.id, b.name)),
          created_at: b.created_at,
          updated_at: b.updated_at,
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
    const { data, error } = await this.sb.from('notes').select(this.noteCols()).order('updated_at', { ascending: false });
    check(error);
    return Promise.all(((data ?? []) as unknown as NoteRow[]).map((r) => this.decodeNote(r)));
  }

  async createNote(title: string, notebookId: string): Promise<NoteMeta> {
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
    await this.write(async (key) => {
      const rows = await Promise.all(
        notes.map(async (n) => ({
          id: n.id,
          user_id: this.userId,
          ...(await this.encodeTitle(key, n.id, n.title)),
          notebook_id: n.notebook_id,
          created_at: n.created_at,
          updated_at: n.updated_at,
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
      // Saving strokes bumps the note's date; put the original back.
      if (changed) {
        const { error } = await this.sb.from('notes').update({ updated_at: r.updated_at }).eq('id', r.id);
        check(error);
      }
      onProgress(i + 1, list.length);
    }
    // Anything written meanwhile by another device (notes made after the list above was read).
    await this.convertStrokes(target, encrypting, null);
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
  }

  /** Convert one note's strokes (or every remaining one, with noteId null). Returns how many changed. */
  private async convertStrokes(target: CryptoKey | null, encrypting: boolean, noteId: string | null) {
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
