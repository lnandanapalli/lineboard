import type { NoteMeta, Settings, Stroke } from '../types';

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
  listNotes(): Promise<NoteMeta[]>;
  createNote(title: string): Promise<NoteMeta>;
  renameNote(id: string, title: string): Promise<void>;
  deleteNote(id: string): Promise<void>;
  loadStrokes(noteId: string): Promise<Stroke[]>;
  upsertStrokes(strokes: Stroke[]): Promise<void>;
  deleteStrokes(ids: string[]): Promise<void>;
  loadSettings(): Promise<Partial<Settings> | null>;
  saveSettings(s: Settings): Promise<void>;
}
