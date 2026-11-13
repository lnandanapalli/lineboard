import { DEFAULT_NOTEBOOK_NAME, type Notebook, type NoteMeta, type Settings, type Stroke } from '../types';
import { lsGet, lsSet, uuid } from '../util';
import type { Store } from './store';

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
    return (await this.listNotebooks())[0] ?? this.createNotebook(DEFAULT_NOTEBOOK_NAME);
  }
  async createNotebook(name: string) {
    const now = new Date().toISOString();
    const b: Notebook = { id: uuid(), name, created_at: now, updated_at: now };
    this.saveNotebooks([...this.notebooks(), b]);
    return b;
  }
  async renameNotebook(id: string, name: string) {
    this.saveNotebooks(this.notebooks().map((b) => (b.id === id ? { ...b, name } : b)));
  }
  async deleteNotebook(id: string) {
    for (const n of this.notes().filter((m) => m.notebook_id === id)) await this.deleteNote(n.id);
    this.saveNotebooks(this.notebooks().filter((b) => b.id !== id));
  }
  async moveNotes(noteIds: string[], notebookId: string) {
    const ids = new Set(noteIds);
    this.saveNotes(this.notes().map((m) => (ids.has(m.id) ? { ...m, notebook_id: notebookId } : m)));
  }

  async listNotes() {
    return this.notes().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async createNote(title: string, notebookId: string) {
    const now = new Date().toISOString();
    const m: NoteMeta = { id: uuid(), title, notebook_id: notebookId, created_at: now, updated_at: now };
    this.saveNotes([m, ...this.notes()]);
    return m;
  }
  async renameNote(id: string, title: string) {
    const n = this.notes();
    const x = n.find((m) => m.id === id);
    if (x) x.title = title;
    this.saveNotes(n);
  }
  async deleteNote(id: string) {
    this.saveNotes(this.notes().filter((m) => m.id !== id));
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
  /** Remove every note, stroke and setting kept on this device. */
  clearAll() {
    for (const m of this.notes()) {
      try {
        localStorage.removeItem(this.strokesKey(m.id));
      } catch {
        /* ignore */
      }
    }
    for (const k of ['lb-local-notes', 'lb-local-notebooks', 'lb-local-settings']) {
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
