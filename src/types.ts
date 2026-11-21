import { LINE_STYLES, SHAPES, type LineStyle, type ShapeKind } from './shapes';
import { cleanStyle, type TextStyle } from './textStyle';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'shape' | 'text' | 'select';

/**
 * How the page takes ink.
 * strips  one unlocked strip at a time (palm rests anywhere else)
 * multi   any number of strips unlocked at once
 * free    whole page takes ink, two fingers scroll and zoom
 * split   the screen is two panes (top/bottom), each locked or unlocked; the page scrolls under them
 */
export type BoardMode = 'strips' | 'multi' | 'split' | 'free';
export const BOARD_MODES: BoardMode[] = ['strips', 'multi', 'split', 'free'];

/** A single ink stroke. Coordinates are in page units: the page is always 1000 units wide. */
export interface Stroke {
  id: string;
  note_id: string;
  /**
   * 'text': a text box. Its points are [x, y, 0] (top-left), width is the font size.
   * 'image': a picture. Its points are [left, top, 0, right, bottom, 0], `text` is the image's id in
   * the image store and `color` its file type (e.g. "image/png").
   */
  tool: 'pen' | 'highlighter' | 'text' | 'image';
  color: string;
  width: number;
  /** Flat list: x0, y0, p0, x1, y1, p1, ... (p = pressure 0..1) */
  points: number[];
  /** Text boxes: the text. Images: the image id. */
  text?: string;
  /** Pen strokes (shapes): drawn dashed or dotted instead of solid. */
  dash?: 'dashed' | 'dotted';
  /** Text boxes: font family, bold / italic / underline, alignment (absent: plain sans, left). */
  font?: TextStyle;
  created_at?: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  /** Null only for notes made before notebooks existed; the app moves them into the default notebook. */
  notebook_id: string | null;
  created_at: string;
  updated_at: string;
  /** Pinned to the top of the sidebar ("Starred"). */
  starred?: boolean;
  /** Archived: hidden from the sidebar and search, kept in Settings > Data controls. */
  archived_at?: string | null;
  /** In the trash since then: hidden everywhere, deleted for good after TRASH_DAYS. */
  deleted_at?: string | null;
}

/** Flags a note or notebook can have, changed without touching its content or date. */
export type Flags = { starred?: boolean; archived_at?: string | null; deleted_at?: string | null };

/** The trash notebook's name. */
export const TRASH_NAME = 'Trash';

/** Days a note or notebook stays in the trash before it is deleted for good. */
export const TRASH_DAYS = 30;

export interface Notebook {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  starred?: boolean;
  archived_at?: string | null;
  /** In the trash since then (its notes go with it). */
  deleted_at?: string | null;
}

export const DEFAULT_NOTEBOOK_NAME = 'My Notebook';

export interface Settings {
  /** Strip height in page units (page width = 1000). */
  stripHeight: number;
  /**
   * Palm detection: 'auto' learns the writing contact from the first strokes each time the app
   * opens; 'manual' uses touchThreshold.
   */
  palmMode: 'auto' | 'manual';
  /** Manual palm detection: touches with a contact size (CSS px) above this are treated as palm. */
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
  /** Stroke smoothing, 0 (off) to 1 (strong). Steadies shaky lines as they are drawn. */
  smoothing: number;
  /** The shape the shape tool draws. */
  shape: ShapeKind;
  /** Shapes keep equal sides (square, circle...) and lines snap to 45°. */
  shapeLock: boolean;
  /** Shape outlines: solid, dashed or dotted. */
  shapeDash: LineStyle;
  /** Shape outline thickness (page units). */
  shapeWidth: number;
  /** How the Select tool picks: a free-hand loop or a dragged rectangle. */
  selectMode: 'lasso' | 'rect';
  /** Font size for new text boxes (page units). */
  textSize: number;
  /** Font, emphasis and alignment for new text boxes (the last ones used). */
  textStyle: TextStyle;
  /** Split mode: where the divider sits, as a fraction of the board's height. */
  splitRatio: number;
  /** The free whiteboard's paper. */
  paper: Paper;
}

export type Paper = 'plain' | 'lines' | 'grid' | 'dots';
export const PAPERS: Paper[] = ['plain', 'lines', 'grid', 'dots'];

export const DEFAULT_SETTINGS: Settings = {
  stripHeight: 90,
  palmMode: 'auto',
  touchThreshold: 45,
  penOnlyWhenPenSeen: true,
  showLines: true,
  mode: 'split',
  marginSide: 'left',
  penColor: '#111827',
  penWidth: 3.5,
  highlighterColor: '#fde047',
  highlighterWidth: 22,
  smoothing: 0.25,
  shape: 'rectangle',
  shapeLock: false,
  shapeDash: 'solid',
  shapeWidth: 3.5,
  selectMode: 'lasso',
  textSize: 28,
  textStyle: {},
  splitRatio: 0.5,
  paper: 'plain',
};

/**
 * Merge stored settings over the defaults. Settings saved before the mode menu had a
 * `freeMode` flag instead of `mode`; carry it over.
 */
export function withDefaults(stored: Partial<Settings> & { freeMode?: boolean } | null | undefined): Settings {
  const { freeMode, ...rest } = stored ?? {};
  const out: Settings = { ...DEFAULT_SETTINGS, ...rest };
  // Automatic unless someone deliberately turned the manual limit on (a limit saved before
  // automatic detection existed is kept, and used only if they turn it on).
  if (out.palmMode !== 'manual') out.palmMode = 'auto';
  if (!rest.mode && freeMode) out.mode = 'free';
  if (!BOARD_MODES.includes(out.mode)) out.mode = 'strips';
  if (!(SHAPES as readonly string[]).includes(out.shape)) out.shape = 'rectangle';
  if (!LINE_STYLES.includes(out.shapeDash)) out.shapeDash = 'solid';
  if (!(out.shapeWidth >= 1 && out.shapeWidth <= 20)) out.shapeWidth = DEFAULT_SETTINGS.shapeWidth;
  if (out.selectMode !== 'rect') out.selectMode = 'lasso';
  // Every number within what its control offers (a stored value may be old, edited or damaged).
  const within = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
  const D = DEFAULT_SETTINGS;
  out.stripHeight = within(out.stripHeight, 40, 220, D.stripHeight);
  out.touchThreshold = within(out.touchThreshold, 5, 150, D.touchThreshold);
  out.penWidth = within(out.penWidth, 1, 24, D.penWidth);
  out.highlighterWidth = within(out.highlighterWidth, 6, 60, D.highlighterWidth);
  out.smoothing = within(out.smoothing, 0, 1, D.smoothing);
  out.textSize = within(out.textSize, 10, 100, D.textSize);
  out.splitRatio = within(out.splitRatio, 0.15, 0.85, D.splitRatio);
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback);
  out.penColor = color(out.penColor, D.penColor);
  out.highlighterColor = color(out.highlighterColor, D.highlighterColor);
  for (const k of ['penOnlyWhenPenSeen', 'showLines', 'shapeLock'] as const) if (typeof out[k] !== 'boolean') out[k] = D[k];
  if (out.marginSide !== 'right') out.marginSide = 'left';
  if (!PAPERS.includes(out.paper)) out.paper = 'plain';
  out.textStyle = cleanStyle(out.textStyle);
  return out;
}

export interface AppUser {
  id: string;
  email: string | null;
}
