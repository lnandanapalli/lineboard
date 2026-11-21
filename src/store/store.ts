import type { SnapStroke, VersionMeta } from '../history';
import type { Profile } from '../profile';
import type { Flags, Notebook, NoteMeta, Settings, Stroke } from '../types';

export class StoreError extends Error {
  /** Permanent errors (bad data, permission) are dropped from the sync queue instead of retried. */
  constructor(
    message: string,
    public permanent: boolean,
  ) {
    super(message);
  }
}

/**
 * The note or notebook an action was aimed at is not there any more (or, for a notebook, is in the
 * trash): most likely another device or tab deleted it. Permanent: trying again cannot help.
 */
export class GoneError extends StoreError {
  constructor(public what: 'note' | 'notebook') {
    super(what === 'note' ? 'That note no longer exists. It may have been deleted on another device.' : 'That notebook no longer exists. It may have been deleted on another device.', true);
  }
}

export interface Store {
  readonly mode: 'cloud' | 'local';
  listNotebooks(): Promise<Notebook[]>;
  /** The user's default notebook, created if missing (safe to call from several devices at once). */
  ensureDefaultNotebook(): Promise<Notebook>;
  createNotebook(name: string): Promise<Notebook>;
  /** Renames it; GoneError if it no longer exists. */
  renameNotebook(id: string, name: string): Promise<void>;
  /** Deletes the notebook and every note in it, for good. */
  deleteNotebook(id: string): Promise<void>;
  /**
   * The trash: a notebook of its own, hidden from the notebook list. Notes in it have deleted_at set.
   * Made if missing (safe to call from several devices at once).
   */
  readonly trashId: string;
  ensureTrash(): Promise<Notebook>;
  listNotes(): Promise<NoteMeta[]>;
  /** GoneError if the notebook no longer exists or is in the trash. */
  createNote(title: string, notebookId: string): Promise<NoteMeta>;
  /**
   * Move notes into a notebook, or into the trash (trashId: deleted_at is set, star and archive
   * cleared). GoneError if the notebook no longer exists or is in the trash, or a note is gone.
   */
  moveNotes(noteIds: string[], notebookId: string): Promise<void>;
  /** Renames it; GoneError if it no longer exists. */
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
  /** The user's display name and picture. */
  loadProfile(): Promise<Profile>;
  /** Change the name and / or the picture (null removes it); returns the profile as saved. */
  saveProfile(change: { name?: string; picture?: Blob | null }): Promise<Profile>;
  /** The profile picture's file, or null when there is none (or it cannot be read here). */
  loadProfilePicture(p: Profile): Promise<Blob | null>;
  /**
   * Star / archive a note or notebook, or move a notebook to the trash and back (deleted_at); its
   * content and date are left alone. GoneError if it no longer exists.
   */
  setNoteFlags(id: string, flags: Flags): Promise<void>;
  setNotebookFlags(id: string, flags: Flags): Promise<void>;
  /** False when the cloud database predates stars and the archive (schema not updated yet). */
  supportsFlags?(): Promise<boolean>;
  /** False when the cloud database predates the trash (schema not updated yet): deleting is then permanent. */
  supportsTrash?(): Promise<boolean>;
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
