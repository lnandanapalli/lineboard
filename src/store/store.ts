import type { SnapStroke, VersionMeta } from '../history';
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
  /** Save an image file under an id (images are referenced by 'image' strokes). */
  putImage(id: string, file: Blob): Promise<void>;
  /** Load an image file saved with putImage (`type`: its file type, from the image stroke). */
  getImage(id: string, type?: string): Promise<Blob>;
  /** A note's versions, newest first (without their content). */
  listVersions(noteId: string): Promise<VersionMeta[]>;
  /** One version's strokes. */
  loadVersion(v: VersionMeta): Promise<SnapStroke[]>;
  /** Save a version (its id, note and date are in `v`). */
  saveVersion(v: VersionMeta, strokes: SnapStroke[]): Promise<void>;
  /** Name a version, or remove its name (null). */
  renameVersion(v: VersionMeta, name: string | null): Promise<void>;
  deleteVersions(ids: string[]): Promise<void>;
  /** False when the cloud database predates version history (schema not updated yet). */
  supportsHistory?(): Promise<boolean>;
  /** False when the cloud database predates text boxes (schema not updated yet). */
  supportsText?(): Promise<boolean>;
}
