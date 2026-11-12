import type { SupabaseClient } from '@supabase/supabase-js';
import type { NoteMeta, Settings, Stroke } from '../types';
import { StoreError, type Store } from './store';

const PAGE = 1000; // PostgREST default max rows per request
const CHUNK = 200;

interface PgErr {
  message: string;
  code?: string;
}

function check(error: PgErr | null) {
  if (!error) return;
  // SQLSTATE classes 22 (data), 23 (constraint), 42 (syntax/permission) won't succeed on retry.
  const permanent = !!error.code && /^(22|23|42)/.test(error.code);
  throw new StoreError(error.message || 'Request failed', permanent);
}

export class SupabaseStore implements Store {
  readonly mode = 'cloud' as const;
  constructor(
    private sb: SupabaseClient,
    private userId: string,
  ) {}

  async listNotes(): Promise<NoteMeta[]> {
    const { data, error } = await this.sb
      .from('notes')
      .select('id,title,created_at,updated_at')
      .order('updated_at', { ascending: false });
    check(error);
    return (data ?? []) as NoteMeta[];
  }

  async createNote(title: string): Promise<NoteMeta> {
    const { data, error } = await this.sb
      .from('notes')
      .insert({ title, user_id: this.userId })
      .select('id,title,created_at,updated_at')
      .single();
    check(error);
    return data as NoteMeta;
  }

  /** Insert or update notes keeping their ids (used to move notes made without an account). Idempotent. */
  async importNotes(notes: NoteMeta[]) {
    if (!notes.length) return;
    const rows = notes.map((n) => ({ id: n.id, user_id: this.userId, title: n.title, created_at: n.created_at, updated_at: n.updated_at }));
    const { error } = await this.sb.from('notes').upsert(rows, { onConflict: 'id' });
    check(error);
  }

  async renameNote(id: string, title: string) {
    const { error } = await this.sb.from('notes').update({ title }).eq('id', id);
    check(error);
  }

  async deleteNote(id: string) {
    const { error } = await this.sb.from('notes').delete().eq('id', id);
    check(error);
  }

  async loadStrokes(noteId: string): Promise<Stroke[]> {
    const out: Stroke[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb
        .from('strokes')
        .select('id,note_id,tool,color,width,points,created_at')
        .eq('note_id', noteId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      check(error);
      const rows = (data ?? []) as Stroke[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async upsertStrokes(strokes: Stroke[]) {
    for (let i = 0; i < strokes.length; i += CHUNK) {
      const rows = strokes.slice(i, i + CHUNK).map((s) => ({
        id: s.id,
        note_id: s.note_id,
        user_id: this.userId,
        tool: s.tool,
        color: s.color,
        width: s.width,
        points: s.points,
        created_at: s.created_at,
      }));
      const { error } = await this.sb.from('strokes').upsert(rows, { onConflict: 'id' });
      check(error);
    }
  }

  async deleteStrokes(ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await this.sb.from('strokes').delete().in('id', ids.slice(i, i + CHUNK));
      check(error);
    }
  }

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
}
