export type Tool = 'pen' | 'highlighter' | 'eraser';

/**
 * How the page takes ink.
 * strips  one unlocked strip at a time (palm rests anywhere else)
 * multi   any number of strips unlocked at once
 * free    whole page takes ink, two fingers scroll and zoom
 */
export type BoardMode = 'strips' | 'multi' | 'free';
export const BOARD_MODES: BoardMode[] = ['strips', 'multi', 'free'];

/** A single ink stroke. Coordinates are in page units: the page is always 1000 units wide. */
export interface Stroke {
  id: string;
  note_id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  /** Flat list: x0, y0, p0, x1, y1, p1, ... (p = pressure 0..1) */
  points: number[];
  created_at?: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  /** Null only for notes made before notebooks existed; the app moves them into the default notebook. */
  notebook_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_NOTEBOOK_NAME = 'My Notebook';

export interface Settings {
  /** Strip height in page units (page width = 1000). */
  stripHeight: number;
  /** Touches with a contact size (CSS px) above this are treated as palm. */
  touchThreshold: number;
  /** If an active pen (pointerType "pen") is ever seen, ignore finger touches entirely. */
  penOnlyWhenPenSeen: boolean;
  showLines: boolean;
  mode: BoardMode;
  marginSide: 'left' | 'right';
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  stripHeight: 90,
  touchThreshold: 45,
  penOnlyWhenPenSeen: true,
  showLines: true,
  mode: 'strips',
  marginSide: 'left',
  penColor: '#111827',
  penWidth: 3.5,
  highlighterColor: '#fde047',
  highlighterWidth: 22,
};

/**
 * Merge stored settings over the defaults. Settings saved before the mode menu had a
 * `freeMode` flag instead of `mode`; carry it over.
 */
export function withDefaults(stored: Partial<Settings> & { freeMode?: boolean } | null | undefined): Settings {
  const { freeMode, ...rest } = stored ?? {};
  const out: Settings = { ...DEFAULT_SETTINGS, ...rest };
  if (!rest.mode && freeMode) out.mode = 'free';
  if (!BOARD_MODES.includes(out.mode)) out.mode = 'strips';
  return out;
}

export interface AppUser {
  id: string;
  email: string | null;
}
