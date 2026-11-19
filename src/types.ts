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
  if (!rest.mode && freeMode) out.mode = 'free';
  if (!BOARD_MODES.includes(out.mode)) out.mode = 'strips';
  if (!(SHAPES as readonly string[]).includes(out.shape)) out.shape = 'rectangle';
  if (!LINE_STYLES.includes(out.shapeDash)) out.shapeDash = 'solid';
  if (!(out.shapeWidth >= 1 && out.shapeWidth <= 20)) out.shapeWidth = DEFAULT_SETTINGS.shapeWidth;
  if (out.selectMode !== 'rect') out.selectMode = 'lasso';
  if (!PAPERS.includes(out.paper)) out.paper = 'plain';
  out.textStyle = cleanStyle(out.textStyle);
  return out;
}

export interface AppUser {
  id: string;
  email: string | null;
}
