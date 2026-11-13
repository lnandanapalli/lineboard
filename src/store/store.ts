import type { Notebook, NoteMeta, Settings, Stroke } from '../types';

export class StoreError extends Error {
  /** Permanent errors (bad data, permission) are dropped from the sync queue instead of retried. */
  constructor(
    message: string,
    public permanent: boolean,
  ) {
    super(message);
  }
}

export interface Store {
  readonly mode: 'cloud' | 'local';
  listNotebooks(): Promise<Notebook[]>;
  /** The user's default notebook, created if missing (safe to call from several devices at once). */
  ensureDefaultNotebook(): Promise<Notebook>;
  createNotebook(name: string): Promise<Notebook>;
  renameNotebook(id: string, name: string): Promise<void>;
  /** Deletes the notebook and every note in it. */
  deleteNotebook(id: string): Promise<void>;
  listNotes(): Promise<NoteMeta[]>;
  createNote(title: string, notebookId: string): Promise<NoteMeta>;
  moveNotes(noteIds: string[], notebookId: string): Promise<void>;
  renameNote(id: string, title: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
  loadStrokes(noteId: string): Promise<Stroke[]>;
  upsertStrokes(strokes: Stroke[]): Promise<void>;
  deleteStrokes(ids: string[]): Promise<void>;
  loadSettings(): Promise<Partial<Settings> | null>;
  saveSettings(s: Settings): Promise<void>;
}
