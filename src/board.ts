import type { Settings, Stroke, Tool } from './types';
import { uuid } from './util';
import { appRect, clientToApp, deltaToApp } from './orientation';
import { shapeStrokes } from './shapes';
import { cleanStyle, fontCss, isPlain, type TextStyle } from './textStyle';
import { createTextBar, type TextFormatPatch } from './textBar';

/** Logical page width. All stroke coordinates live in this space. */
export const PAGE_W = 1000;
/** A stroke that ends within this many ms with almost no movement, via pointercancel, is discarded. */
const SETTLE_MS = 90;
const ERASER_RADIUS = 12;
const MIN_POINT_DIST = 0.6;
/** Free mode: two fingers that land within this many ms of each other start a two-finger scroll. */
const PAN_PAIR_MS = 300;
/** ...and a stroke the first finger already started is dropped only if it is this young. */
const PAN_DROP_STROKE_MS = 250;
/** Free mode pinch-zoom range (1 = page fits the width, as in strip mode). */
const MAX_ZOOM = 4;

export interface BoardCallbacks {
  onStrokesAdded(strokes: Stroke[]): void;
  onStrokesRemoved(strokes: Stroke[]): void;
  /** A text box was edited: `before` is replaced by `after`. */
  onStrokesReplaced(before: Stroke[], after: Stroke[]): void;
  /** The text format bar changed the style, size or colour: remember it for the next text box. */
  onTextFormat?(f: { style: TextStyle; size: number; color: string }): void;
  /** Reports every contact that touches the drawing area (used for calibration readout). */
  onContact(size: number, pointerType: string, accepted: boolean): void;
  onUnlockChange(unlocked: number[]): void;
  /** Split mode: the divider was moved (fraction of the board's height). */
  onSplitRatio?(ratio: number): void;
  /** Load a picture referenced by an 'image' stroke. */
  loadImage?(id: string, type: string): Promise<Blob>;
}

interface Cached {
  s: Stroke;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  variable: boolean;
  path: Path2D | null;
  /** Dashed strokes: the outline split at its corners, each piece with its length. */
  pieces?: { path: Path2D; len: number }[];
}

interface ActiveInput {
  pointerId: number;
  pointerType: string;
  kind: 'draw' | 'erase' | 'shape' | 'lasso' | 'move' | 'scale';
  start: number;
  points: number[];
  erased: Cached[];
  /** The latest raw (unsmoothed) input point, so the stroke can end exactly where the pen lifted. */
  raw: [number, number, number] | null;
  /** Shape tool: where the drag started, where it is now, and whether Shift is held. */
  shape?: { x0: number; y0: number; x1: number; y1: number; constrain: boolean };
  /** Select tool: the loop being drawn, or how far the selection has been dragged. */
  lasso?: number[];
  /** Select tool, rectangle mode: the box being dragged out. */
  rect?: { x0: number; y0: number; x1: number; y1: number };
  move?: { x0: number; y0: number; dx: number; dy: number };
  /** Select tool: resizing the selection from its corner handle, about its top-left corner. */
  scale?: { ax: number; ay: number; bx: number; by: number; f: number };
}

/** Is (x, y) inside the polygon [x0, y0, x1, y1, ...]? (ray casting) */
function inPolygon(poly: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Do segments (a, b) and (c, d) cross? */
function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Does a polyline [x, y, x, y...] cross the closed polygon's outline? */
function crossesOutline(line: number[], poly: number[]): boolean {
  for (let i = 2; i < line.length; i += 2)
    for (let j = 0, k = poly.length - 2; j < poly.length; k = j, j += 2)
      if (segmentsCross(line[i - 2], line[i - 1], line[i], line[i + 1], poly[k], poly[k + 1], poly[j], poly[j + 1])) return true;
  return false;
}

/** A copy of a stroke scaled by f about (ax, ay). Text grows with it; ink keeps its pen width. */
function scaled(s: Stroke, ax: number, ay: number, f: number): Stroke {
  const p = s.points.slice();
  for (let i = 0; i < p.length; i += 3) {
    p[i] = Math.round((ax + (p[i] - ax) * f) * 10) / 10;
    p[i + 1] = Math.round((ay + (p[i + 1] - ay) * f) * 10) / 10;
  }
  const width = s.tool === 'text' ? Math.min(100, Math.max(4, Math.round(s.width * f * 10) / 10)) : s.width;
  return { ...s, points: p, width };
}

/** A copy of a stroke moved by (dx, dy); `id` defaults to the same one. */
function moved(s: Stroke, dx: number, dy: number, id = s.id): Stroke {
  const p = s.points.slice();
  // Every kind keeps x, y, p triples (text: its corner; pictures: two corners), so one loop moves all.
  for (let i = 0; i < p.length; i += 3) {
    p[i] = Math.round((p[i] + dx) * 10) / 10;
    p[i + 1] = Math.round((p[i + 1] + dy) * 10) / 10;
  }
  return { ...s, id, points: p };
}

interface MarginDrag {
  pointerId: number;
  y0: number;
  scroll0: number;
  moved: boolean;
  /** Split mode: this drag moves the divider (it was activated first) instead of scrolling. */
  divider?: boolean;
}

/** Split mode: the divider's grip in the margin is this tall (px), and it stays within these bounds. */
const SPLIT_GRIP = 30;
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const UNLOCK_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 15v2" stroke="currentColor" stroke-width="2"/></svg>';

export const TEXT_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const TEXT_LINE = 1.25;
/** Longest text box the database accepts (strokes.text check in supabase/schema.sql). */
export const MAX_TEXT = 10000;
let measureCtx: CanvasRenderingContext2D | null = null;
/** Width and height (page units) of a text box. */
function textBox(text: string, size: number, style?: TextStyle) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = fontCss(style, size);
  const lines = text.split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  return { w: Math.max(w, size * 0.3), h: lines.length * size * TEXT_LINE };
}

const GRIP_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 9h14M5 15h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function contactSize(e: PointerEvent): number {
  return Math.max(e.width || 0, e.height || 0);
}

function pressureFactor(p: number): number {
  return 0.4 + p * 1.2; // p=0.5 -> 1.0
}

export class Board {
  readonly el: HTMLElement;
  private margin: HTMLElement;
  private area: HTMLElement;
  private bg: HTMLCanvasElement;
  private ink: HTMLCanvasElement;
  private live: HTMLCanvasElement;
  private bgCtx: CanvasRenderingContext2D;
  private inkCtx: CanvasRenderingContext2D;
  private liveCtx: CanvasRenderingContext2D;

  private strokes: Cached[] = [];
  private byId = new Map<string, Cached>();
  private noteId = '';

  private scrollY = 0;
  /** Horizontal scroll, only non-zero when zoomed in (free mode). */
  private scrollX = 0;
  /** Width-fit scale; `scale` = baseScale * zoom. */
  private baseScale = 1;
  private zoom = 1;
  private scale = 1;
  private dpr = 1;
  private viewW = 0;
  private viewH = 0;

  private unlocked = new Set<number>();
  /** Split mode: which panes take ink, and whether the divider is armed for moving. */
  private panes = { top: true, bottom: false };
  private dividerArmed = false;
  tool: Tool = 'pen';
  private penSeen = false;

  private active: ActiveInput | null = null;
  private marginDrag: MarginDrag | null = null;
  /** Free mode: finger-sized touches currently on the page, for two-finger scrolling. */
  private fingers = new Map<number, { x: number; y: number; t: number }>();
  /** Two-finger gesture: the page point under the fingers stays under them while they move and pinch. */
  private pan: { startDist: number; startZoom: number; anchorX: number; anchorY: number } | null = null;
  private eraserCursor: { x: number; y: number } | null = null;
  /** Pictures for 'image' strokes, by image id. */
  private images = new Map<string, ImageBitmap | 'loading' | 'error'>();
  /** Pictures being added (prepared, encrypted, uploaded): a placeholder box shows where each will go. */
  private pending = new Map<number, { l: number; t: number; w: number; h: number; offset: number }>();
  private pendingSeq = 0;
  /** Select tool: the selected strokes, and the Delete / Duplicate bar shown above them. */
  private selection = new Set<Cached>();
  private selectBar: HTMLElement | null = null;
  /** Text box being typed (new, or editing an existing one). */
  private editor: { el: HTMLTextAreaElement; x: number; y: number; size: number; color: string; style: TextStyle; original: Cached | null } | null = null;
  /** Text formatting controls, shown while typing or when only text boxes are selected. */
  private textBar: ReturnType<typeof createTextBar> | null = null;

  private dirty = { bg: false, ink: false, live: false, margin: false };
  private rafId = 0;
  private scrollAnim = 0;

  constructor(
    host: HTMLElement,
    private settings: Settings,
    private cb: BoardCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.margin = document.createElement('div');
    this.margin.className = 'margin';
    this.area = document.createElement('div');
    this.area.className = 'canvas-area';
    this.bg = document.createElement('canvas');
    this.ink = document.createElement('canvas');
    this.live = document.createElement('canvas');
    this.live.className = 'live';
    this.area.append(this.bg, this.ink, this.live);
    this.el.append(this.margin, this.area);
    host.append(this.el);

    this.settings = { ...settings };
    this.bgCtx = this.bg.getContext('2d')!;
    this.inkCtx = this.ink.getContext('2d')!;
    this.liveCtx = this.live.getContext('2d')!;

    this.applyMarginSide();
    this.bindInput();
    // Text measured while its font was still loading is measured again once it arrives.
    document.fonts?.addEventListener?.('loadingdone', () => this.remeasureText());
    new ResizeObserver(() => this.resize()).observe(this.area);
    this.resize();
  }

  // ----------------------------- public API -----------------------------

  setStrokes(noteId: string, strokes: Stroke[]) {
    // The same note reloading (its saved strokes arriving after it opened) keeps a text box being
    // typed; a different note finishes it first.
    const sameNote = noteId === this.noteId && !!this.editor;
    if (!sameNote) this.commitText();
    this.clearSelection();
    this.cancelActive();
    this.noteId = noteId;
    this.strokes = [];
    this.byId.clear();
    for (const s of strokes) this.cache(s);
    if (sameNote) {
      // Keep the place on the page, and point an edit at the freshly loaded copy of its text box.
      const ed = this.editor!;
      if (ed.original) ed.original = this.byId.get(ed.original.s.id) ?? null;
      this.invalidate('bg', 'ink', 'live', 'margin');
      return;
    }
    this.scrollY = 0;
    // Unlock the first empty strip after existing content, so you can continue where you left off.
    const H = this.settings.stripHeight;
    const next = this.strokes.length ? Math.floor(this.contentBottom() / H) + 1 : 0;
    this.unlocked = new Set([next]);
    this.ensureVisible(next, false);
    this.cb.onUnlockChange(this.unlockedList());
    this.invalidate('bg', 'ink', 'live', 'margin');
  }

  /** Re-add strokes (undo of erase / redo of add). */
  addStrokes(strokes: Stroke[]) {
    for (const s of strokes) if (!this.byId.has(s.id)) this.cache(s);
    this.invalidate('ink', 'bg', 'margin');
  }

  removeStrokes(ids: string[]) {
    const set = new Set(ids);
    for (const c of this.selection) if (set.has(c.s.id)) this.selection.delete(c);
    this.invalidate('live');
    if (this.editor?.original && set.has(this.editor.original.s.id)) this.closeEditor();
    this.strokes = this.strokes.filter((c) => !set.has(c.s.id));
    for (const id of ids) this.byId.delete(id);
    this.invalidate('ink');
  }

  updateSettings(s: Settings) {
    const oldH = this.settings.stripHeight;
    const oldMode = this.settings.mode;
    this.settings = { ...s }; // own copy, so changes can be compared with the previous settings
    if (s.mode !== 'split') this.dividerArmed = false;
    if (oldMode === 'multi' && s.mode === 'strips') {
      // Leaving multi-strip locks everything; unlock one strip again by tapping its lock.
      this.unlocked.clear();
      this.cb.onUnlockChange([]);
    }
    if (s.mode !== 'free') {
      this.fingers.clear();
      this.pan = null;
      if (this.zoom !== 1 || this.scrollX) {
        this.zoom = 1; // back to strips: normal size again
        this.scrollX = 0;
        this.scale = this.baseScale;
      }
    }
    if (s.stripHeight !== oldH) {
      // Keep the same place on the page: map each unlocked strip to the new strip under its centre.
      this.unlocked = new Set([...this.unlocked].map((i) => Math.floor(((i + 0.5) * oldH) / s.stripHeight)));
      this.cb.onUnlockChange(this.unlockedList());
    }
    this.applyMarginSide();
    this.invalidate('bg', 'ink', 'live', 'margin');
  }

  setTool(t: Tool) {
    if (t !== 'text') this.commitText();
    if (t !== 'select') this.clearSelection();
    this.tool = t;
    this.eraserCursor = null;
    this.invalidate('live');
  }

  /** Move the single unlocked strip up/down (dir = +/-1) and scroll it into a comfortable spot. */
  stepLine(dir: 1 | -1) {
    const H = this.settings.stripHeight;
    let i: number;
    if (this.unlocked.size === 0) {
      i = Math.max(0, Math.floor((this.scrollY + (this.viewH / this.scale) * 0.3) / H));
    } else {
      const list = this.unlockedList();
      i = dir > 0 ? list[list.length - 1] + 1 : list[0] - 1;
    }
    i = Math.max(0, i);
    this.unlocked = new Set([i]);
    this.cb.onUnlockChange([i]);
    this.ensureVisible(i, true);
    this.invalidate('bg', 'margin');
  }

  lockAll() {
    this.unlocked.clear();
    this.panes = { top: false, bottom: false };
    this.cb.onUnlockChange([]);
    this.invalidate('bg', 'live', 'margin');
  }

  scrollBy(dyLogical: number) {
    this.setScroll(this.scrollY + dyLogical);
  }

  /** Render the whole note to a PNG. */
  async exportPNG(): Promise<Blob> {
    const bottom = Math.max(this.contentBottom() + 40, 400);
    let s = 1.6;
    const maxH = 30000;
    if (bottom * s > maxH) s = maxH / bottom;
    const c = document.createElement('canvas');
    c.width = Math.round(PAGE_W * s);
    c.height = Math.round(bottom * s);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    await this.allImagesLoaded();
    for (const pass of [true, false]) for (const cs of this.strokes) if ((cs.s.tool === 'image') === pass) this.drawStroke(ctx, cs);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), 'image/png'));
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  // ----------------------------- geometry -----------------------------

  private cache(s: Stroke): Cached {
    if (s.tool === 'image') {
      const [l, t, , r, b] = s.points;
      const c: Cached = { s, minX: Math.min(l, r), minY: Math.min(t, b), maxX: Math.max(l, r), maxY: Math.max(t, b), variable: false, path: null };
      this.strokes.push(c);
      this.byId.set(s.id, c);
      return c;
    }
    if (s.tool === 'text') {
      // A bundled font (handwriting) may still be loading: measure again once it is in.
      const font = fontCss(s.font, s.width);
      if (s.font?.family && typeof document.fonts?.check === 'function' && !document.fonts.check(font)) void document.fonts.load(font).then(() => this.remeasureText(), () => {});
      const b = textBox(s.text ?? '', s.width, s.font);
      const c: Cached = { s, minX: s.points[0], minY: s.points[1], maxX: s.points[0] + b.w, maxY: s.points[1] + b.h, variable: false, path: null };
      this.strokes.push(c);
      this.byId.set(s.id, c);
      return c;
    }
    const p = s.points;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let pmin = Infinity,
      pmax = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i],
        y = p[i + 1],
        pr = p[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (pr < pmin) pmin = pr;
      if (pr > pmax) pmax = pr;
    }
    const pad = s.width * pressureFactor(1) * 0.5 + 1;
    const c: Cached = {
      s,
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      variable: s.tool === 'pen' && pmax - pmin > 0.05,
      path: null,
    };
    this.strokes.push(c);
    this.byId.set(s.id, c);
    return c;
  }

  private contentBottom(): number {
    let b = 0;
    for (const c of this.strokes) if (c.maxY > b) b = c.maxY;
    return b;
  }

  private pageHeight(): number {
    const H = this.settings.stripHeight;
    const maxUnlocked = this.unlocked.size ? Math.max(...this.unlocked) : 0;
    return Math.max(this.contentBottom() + H * 8, (maxUnlocked + 6) * H, this.viewH / this.scale + H);
  }

  private setScroll(y: number, x = this.scrollX) {
    const max = Math.max(0, this.pageHeight() - this.viewH / this.scale);
    const ny = Math.min(Math.max(0, y), max);
    const nx = Math.min(Math.max(0, x), Math.max(0, PAGE_W - this.viewW / this.scale));
    if (ny === this.scrollY && nx === this.scrollX) return;
    this.scrollY = ny;
    this.scrollX = nx;
    this.invalidate('bg', 'ink', 'live', 'margin');
  }

  private ensureVisible(i: number, animate: boolean) {
    const H = this.settings.stripHeight;
    const viewLogical = this.viewH / this.scale;
    const top = i * H;
    const bottom = top + H;
    let target = this.scrollY;
    // Keep the active strip in the upper ~60% of the screen so the palm has room below.
    if (bottom > this.scrollY + viewLogical * 0.6) target = bottom - viewLogical * 0.6;
    if (top < this.scrollY) target = top - H * 0.5;
    if (target === this.scrollY) return;
    if (!animate) return this.setScroll(target);
    cancelAnimationFrame(this.scrollAnim);
    const from = this.scrollY;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 220);
      const e = 1 - Math.pow(1 - k, 3);
      this.setScroll(from + (target - from) * e);
      if (k < 1) this.scrollAnim = requestAnimationFrame(step);
    };
    this.scrollAnim = requestAnimationFrame(step);
  }

  private unlockedList(): number[] {
    return [...this.unlocked].sort((a, b) => a - b);
  }

  private get free(): boolean {
    return this.settings.mode === 'free';
  }

  private get multi(): boolean {
    return this.settings.mode === 'multi';
  }

  private get split(): boolean {
    return this.settings.mode === 'split';
  }

  /** Split mode: the divider's position in board pixels from the top. */
  private get dividerY(): number {
    return this.viewH * Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, this.settings.splitRatio));
  }

  private isUnlockedAt(y: number): boolean {
    if (this.free) return y >= 0; // free whiteboard: the whole page takes ink
    if (this.split) {
      // Panes are fixed on screen; the page scrolls under them.
      const screenY = (y - this.scrollY) * this.scale;
      return y >= 0 && (screenY < this.dividerY ? this.panes.top : this.panes.bottom);
    }
    return y >= 0 && this.unlocked.has(Math.floor(y / this.settings.stripHeight));
  }

  /** Screen coordinates to page units (taking a manually rotated app into account). */
  private toLogical(clientX: number, clientY: number) {
    const p = clientToApp(clientX, clientY);
    return this.appToLogical(p.x, p.y);
  }

  /** App coordinates (see orientation.ts) to page units. */
  private appToLogical(x: number, y: number) {
    const r = appRect(this.live);
    return { x: (x - r.left) / this.scale + this.scrollX, y: (y - r.top) / this.scale + this.scrollY };
  }

  private toggleStrip(i: number) {
    if (i < 0 || this.free) return;
    if (this.multi) {
      if (this.unlocked.has(i)) this.unlocked.delete(i);
      else this.unlocked.add(i);
    } else if (this.unlocked.has(i)) {
      this.unlocked.clear();
    } else {
      this.unlocked = new Set([i]);
    }
    this.cb.onUnlockChange(this.unlockedList());
    this.invalidate('bg', 'margin');
  }

  private applyMarginSide() {
    this.el.classList.toggle('margin-right', this.settings.marginSide === 'right');
    this.el.classList.toggle('free', this.free);
  }

  // ----------------------------- input -----------------------------

  private bindInput() {
    const L = this.live;
    L.addEventListener('pointerdown', (e) => this.onDown(e));
    L.addEventListener('pointermove', (e) => this.onMove(e));
    L.addEventListener('pointerup', (e) => this.onUp(e, false));
    L.addEventListener('pointercancel', (e) => this.onUp(e, true));
    L.addEventListener('pointerleave', () => {
      if (this.eraserCursor && !this.active) {
        this.eraserCursor = null;
        this.invalidate('live');
      }
    });
    L.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touches on the board are fully handled here. Cancelling the touch events stops the browser
    // from treating a sideways stroke as a gesture, such as swipe-to-go-back navigation.
    // (Pointer events, which do the drawing, still arrive.)
    const block = (e: TouchEvent) => {
      // Let the text box (caret, selection) and the selection's buttons take taps.
      if ((e.target as Element | null)?.closest?.('textarea, .select-bar, .text-bar')) return;
      if (e.cancelable) e.preventDefault();
    };
    this.el.addEventListener('touchstart', block, { passive: false });
    this.el.addEventListener('touchmove', block, { passive: false });

    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const mult = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewH : 1;
        if (e.ctrlKey && this.free) {
          // Trackpad pinch / Ctrl+wheel: zoom around the pointer.
          const at = this.toLogical(e.clientX, e.clientY);
          this.setZoom(this.zoom * Math.exp(-e.deltaY * mult * 0.002));
          const r = appRect(this.live);
          const p = clientToApp(e.clientX, e.clientY);
          this.setScroll(at.y - (p.y - r.top) / this.scale, at.x - (p.x - r.left) / this.scale);
          return;
        }
        const d = deltaToApp(e.deltaX * mult, e.deltaY * mult);
        this.setScroll(this.scrollY + d.dy / this.scale, this.scrollX + d.dx / this.scale);
      },
      { passive: false },
    );

    const M = this.margin;
    M.addEventListener('pointerdown', (e) => {
      if (this.marginDrag) return;
      e.preventDefault();
      M.setPointerCapture(e.pointerId);
      // Split mode: once the divider was armed by tapping its grip, the next drag moves it.
      this.marginDrag = { pointerId: e.pointerId, y0: clientToApp(e.clientX, e.clientY).y, scroll0: this.scrollY, moved: false, divider: this.split && this.dividerArmed };
    });
    M.addEventListener('pointermove', (e) => {
      const d = this.marginDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      const y = clientToApp(e.clientX, e.clientY).y;
      const dy = y - d.y0;
      if (!d.moved && Math.abs(dy) > 10) d.moved = true;
      if (!d.moved) return;
      if (d.divider) {
        const r = appRect(M);
        this.settings.splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (y - r.top) / this.viewH));
        this.invalidate('bg', 'live', 'margin');
      } else this.setScroll(d.scroll0 - dy / this.scale);
    });
    const endMargin = (e: PointerEvent, cancelled: boolean) => {
      const d = this.marginDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      this.marginDrag = null;
      const r = appRect(M);
      const py = clientToApp(e.clientX, e.clientY).y - r.top;
      if (d.divider && d.moved) {
        // One move per activation, so a later scroll can never shift the divider by accident.
        this.dividerArmed = false;
        this.cb.onSplitRatio?.(this.settings.splitRatio);
        this.invalidate('live', 'margin');
        return;
      }
      if (d.moved || cancelled) return;
      if (this.split) {
        if (Math.abs(py - this.dividerY) <= SPLIT_GRIP / 2 + 4) this.dividerArmed = !this.dividerArmed;
        else if (py < this.dividerY) this.panes.top = !this.panes.top;
        else this.panes.bottom = !this.panes.bottom;
        this.invalidate('bg', 'live', 'margin');
        return;
      }
      this.toggleStrip(Math.floor((py / this.scale + this.scrollY) / this.settings.stripHeight));
    };
    M.addEventListener('pointerup', (e) => endMargin(e, false));
    M.addEventListener('pointercancel', (e) => endMargin(e, true));
    M.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onDown(e: PointerEvent) {
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const size = contactSize(e);
    const pt = this.toLogical(e.clientX, e.clientY);
    if (this.free && e.pointerType === 'touch' && size <= this.settings.touchThreshold && this.tryStartPan(e)) return;

    let accept = true;
    if (this.active) accept = false; // first-touch lock: one stroke at a time
    else if (e.pointerType === 'touch') {
      if (this.settings.penOnlyWhenPenSeen && this.penSeen) accept = false;
      else if (size > this.settings.touchThreshold) accept = false; // too big -> palm
    }
    if (accept && !this.isUnlockedAt(pt.y)) accept = false; // only unlocked strips take input
    this.cb.onContact(size, e.pointerType, accept);
    if (!accept) return;

    if (this.tool === 'text') {
      e.preventDefault();
      this.commitText();
      const hit = [...this.strokes].reverse().find((c) => c.s.tool === 'text' && this.strokeHit(c, pt.x, pt.y, 2));
      if (hit) this.openEditor(hit.s.points[0], hit.s.points[1], hit.s.width, hit.s.color, cleanStyle(hit.s.font), hit);
      // The tap marks where the first line is, so the caret sits under the pen.
      else this.openEditor(pt.x, pt.y - this.settings.textSize * 0.6, this.settings.textSize, this.settings.penColor, cleanStyle(this.settings.textStyle), null);
      return;
    }

    e.preventDefault();
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.tool === 'select' && this.onHandle(pt.x, pt.y)) {
      const b = this.selectionBox()!;
      this.active = { pointerId: e.pointerId, pointerType: e.pointerType, kind: 'scale', start: performance.now(), points: [], erased: [], raw: null, scale: { ax: b.minX, ay: b.minY, bx: b.maxX, by: b.maxY, f: 1 } };
      this.invalidate('ink', 'live');
      return;
    }
    if (this.tool === 'select') {
      // Inside the current selection: drag it. Elsewhere: start a new lasso.
      const b = this.selectionBox();
      const inside = b && pt.x >= b.minX && pt.x <= b.maxX && pt.y >= b.minY && pt.y <= b.maxY;
      if (!inside) this.clearSelection();
      this.active = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        kind: inside ? 'move' : 'lasso',
        start: performance.now(),
        points: [],
        erased: [],
        raw: null,
        ...(inside
          ? { move: { x0: pt.x, y0: pt.y, dx: 0, dy: 0 } }
          : this.settings.selectMode === 'rect'
            ? { rect: { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y } }
            : { lasso: [pt.x, pt.y] }),
      };
      this.invalidate('ink', 'live');
      return;
    }
    this.active = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      kind: this.tool === 'eraser' ? 'erase' : this.tool === 'shape' ? 'shape' : 'draw',
      start: performance.now(),
      points: [],
      erased: [],
      raw: null,
    };
    if (this.active.kind === 'shape') {
      this.active.shape = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, constrain: e.shiftKey };
      this.invalidate('live');
      return;
    }
    this.addPoint(pt.x, pt.y, this.pressureOf(e));
  }

  private onMove(e: PointerEvent) {
    if (this.fingers.has(e.pointerId)) {
      this.fingers.set(e.pointerId, { ...clientToApp(e.clientX, e.clientY), t: this.fingers.get(e.pointerId)!.t });
      if (this.pan) {
        const g = this.fingerGeometry();
        if (this.pan.startDist > 0) this.setZoom((this.pan.startZoom * g.dist) / this.pan.startDist);
        const r = appRect(this.live);
        this.setScroll(this.pan.anchorY - (g.cy - r.top) / this.scale, this.pan.anchorX - (g.cx - r.left) / this.scale);
        return;
      }
    }
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) {
      if (!a && this.tool === 'eraser' && e.pointerType === 'mouse') {
        this.eraserCursor = this.toLogical(e.clientX, e.clientY);
        this.invalidate('live');
      }
      return;
    }
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    for (const ev of list) {
      // A contact that grows past the limit mid-stroke is a palm settling down: drop the stroke.
      if (a.pointerType === 'touch' && contactSize(ev) > this.settings.touchThreshold) {
        this.cb.onContact(contactSize(ev), 'touch', false);
        this.cancelActive();
        return;
      }
      const pt = this.toLogical(ev.clientX, ev.clientY);
      if (a.scale) {
        const { ax, ay, bx, by } = a.scale;
        a.scale.f = Math.max(0.05, Math.max((pt.x - ax) / Math.max(1, bx - ax), (pt.y - ay) / Math.max(1, by - ay)));
        this.invalidate('live');
        continue;
      }
      if (a.move) {
        a.move.dx = pt.x - a.move.x0;
        a.move.dy = pt.y - a.move.y0;
        this.invalidate('live');
        continue;
      }
      if (a.rect) {
        a.rect.x1 = pt.x;
        a.rect.y1 = pt.y;
        this.invalidate('live');
        continue;
      }
      if (a.lasso) {
        const n = a.lasso.length;
        if (Math.hypot(pt.x - a.lasso[n - 2], pt.y - a.lasso[n - 1]) >= 2) a.lasso.push(pt.x, pt.y);
        this.invalidate('live');
        continue;
      }
      if (a.shape) {
        a.shape.x1 = pt.x;
        a.shape.y1 = pt.y;
        a.shape.constrain = ev.shiftKey;
        this.invalidate('live');
      } else this.addPoint(pt.x, pt.y, this.pressureOf(ev));
    }
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    if (this.fingers.delete(e.pointerId) && this.pan) {
      if (this.fingers.size < 2) this.pan = null;
      return;
    }
    const a = this.active;
    if (!a || a.pointerId !== e.pointerId) return;
    const dur = performance.now() - a.start;
    if (cancelled && dur < SETTLE_MS && a.points.length <= 6) {
      this.cancelActive();
      return;
    }
    this.finish();
  }

  /**
   * Free mode two-finger scroll. Records finger-sized touches; when a second one lands within
   * PAN_PAIR_MS of the first, scrolling starts (and a just-started stroke from the first finger is dropped).
   * A resting palm plus a pen never qualifies: they don't land together. Returns true if this touch now scrolls.
   */
  private tryStartPan(e: PointerEvent): boolean {
    const now = performance.now();
    for (const [id, f] of this.fingers) if (now - f.t > 5000) this.fingers.delete(id); // stale entries
    this.fingers.set(e.pointerId, { ...clientToApp(e.clientX, e.clientY), t: now });
    if (this.pan || this.fingers.size !== 2) return !!this.pan;
    const [a, b] = [...this.fingers.values()];
    if (Math.abs(a.t - b.t) > PAN_PAIR_MS) return false;
    const act = this.active;
    if (act) {
      if (!this.fingers.has(act.pointerId) || now - act.start > PAN_DROP_STROKE_MS) return false;
      this.cancelActive();
    }
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const g = this.fingerGeometry();
    const anchor = this.appToLogical(g.cx, g.cy);
    this.pan = { startDist: g.dist, startZoom: this.zoom, anchorX: anchor.x, anchorY: anchor.y };
    return true;
  }

  /** Centre of the (first two) fingers and the distance between them, in app coordinates. */
  private fingerGeometry() {
    const [a, b] = [...this.fingers.values()];
    if (!b) return { cx: a.x, cy: a.y, dist: 0 };
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  /** Free mode only: zoom between 1x (page fits the width) and MAX_ZOOM. */
  private setZoom(z: number) {
    const nz = this.free ? Math.min(MAX_ZOOM, Math.max(1, z)) : 1;
    if (nz === this.zoom) return;
    this.zoom = nz;
    this.scale = this.baseScale * nz;
    this.invalidate('bg', 'ink', 'live', 'margin');
  }

  private pressureOf(e: PointerEvent): number {
    if (e.pointerType === 'pen') return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
    return 0.5;
  }

  private addPoint(x: number, y: number, p: number) {
    const a = this.active!;
    const pts = a.points;
    const n = pts.length;
    if (a.kind === 'draw') {
      a.raw = [x, y, p];
      // Stabilizer: each point moves only part of the way from the previous one towards the pen,
      // which evens out tremor. 0 = off; at 1 the line trails the pen by ~85% per sample.
      const k = Math.min(0.85, Math.max(0, this.settings.smoothing) * 0.85);
      if (n >= 3 && k > 0) {
        x = pts[n - 3] + (x - pts[n - 3]) * (1 - k);
        y = pts[n - 2] + (y - pts[n - 2]) * (1 - k);
        p = pts[n - 1] + (p - pts[n - 1]) * (1 - k);
      }
    }
    if (n >= 3) {
      const dx = x - pts[n - 3],
        dy = y - pts[n - 2];
      if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST) return;
    }
    pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
    if (a.kind === 'erase') {
      this.eraserCursor = { x, y };
      this.eraseAt(x, y, a);
    }
    this.invalidate('live');
  }

  private eraseAt(x: number, y: number, a: ActiveInput) {
    const r = ERASER_RADIUS;
    const hit: Cached[] = [];
    for (const c of this.strokes) {
      if (c.s.tool === 'image') continue; // the eraser removes ink, not pictures (select + Delete does)
      if (x < c.minX - r || x > c.maxX + r || y < c.minY - r || y > c.maxY + r) continue;
      if (this.strokeHit(c, x, y, r)) hit.push(c);
    }
    if (!hit.length) return;
    const ids = new Set(hit.map((h) => h.s.id));
    this.strokes = this.strokes.filter((c) => !ids.has(c.s.id));
    for (const h of hit) {
      this.byId.delete(h.s.id);
      this.selection.delete(h);
    }
    a.erased.push(...hit);
    this.invalidate('ink');
  }

  private strokeHit(c: Cached, x: number, y: number, r: number): boolean {
    if (c.s.tool === 'text' || c.s.tool === 'image') return x >= c.minX - r && x <= c.maxX + r && y >= c.minY - r && y <= c.maxY + r;
    const p = c.s.points;
    const tol = r + c.s.width / 2;
    const tol2 = tol * tol;
    if (p.length === 3) {
      const dx = p[0] - x,
        dy = p[1] - y;
      return dx * dx + dy * dy <= tol2;
    }
    for (let i = 3; i < p.length; i += 3) {
      const x1 = p[i - 3],
        y1 = p[i - 2],
        x2 = p[i],
        y2 = p[i + 1];
      const vx = x2 - x1,
        vy = y2 - y1;
      const len2 = vx * vx + vy * vy;
      let t = len2 ? ((x - x1) * vx + (y - y1) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = x1 + t * vx - x,
        dy = y1 + t * vy - y;
      if (dx * dx + dy * dy <= tol2) return true;
    }
    return false;
  }

  // ----------------------------- text boxes -----------------------------

  private openEditor(x: number, y: number, size: number, color: string, style: TextStyle, original: Cached | null) {
    const el = document.createElement('textarea');
    el.className = 'text-editor';
    el.setAttribute('aria-label', 'Text');
    el.spellcheck = true;
    el.wrap = 'off';
    el.maxLength = MAX_TEXT;
    el.value = original?.s.text ?? '';
    this.area.append(el);
    this.editor = { el, x, y, size, color, style, original };
    if (original) this.invalidate('ink'); // hide the original while it is being edited
    el.addEventListener('input', () => this.positionEditor());
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger tool shortcuts
      // The usual shortcuts for bold, italic and underline.
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault();
        const st = this.editor?.style ?? {};
        this.formatText(k === 'b' ? { bold: !st.bold } : k === 'i' ? { italic: !st.italic } : { underline: !st.underline });
        return;
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commitText();
      }
    });
    el.addEventListener('blur', () => {
      // Tapping elsewhere (toolbar, another tool) finishes the text box.
      if (this.editor?.el === el) this.commitText();
    });
    this.positionEditor();
    // Focus inside the tap itself: iPadOS only opens the keyboard for focus during a user gesture.
    el.focus({ preventScroll: true });
    setTimeout(() => {
      if (this.editor?.el === el && document.activeElement !== el) el.focus({ preventScroll: true });
    }, 0);
  }

  private positionEditor() {
    const ed = this.editor;
    if (!ed) return;
    const s = this.scale;
    const st = ed.style;
    const b = textBox(ed.el.value || ' ', ed.size, st);
    // The text itself is exactly as wide as on the page, so alignment matches. Around it: a margin
    // on both sides, because italic and handwritten letters lean past their measured width (and the
    // box clips whatever is outside it), plus room to type into on the side the text grows towards.
    const room = ed.size;
    const edge = ed.size * 0.4;
    const k = st.align === 'right' ? 1 : st.align === 'center' ? 0.5 : 0;
    const padL = edge + room * k;
    const padR = edge + room * (1 - k);
    Object.assign(ed.el.style, {
      boxSizing: 'content-box',
      left: `${(ed.x - padL - this.scrollX) * s}px`,
      top: `${(ed.y - this.scrollY) * s}px`,
      paddingLeft: `${padL * s}px`,
      paddingRight: `${padR * s}px`,
      font: fontCss(st, ed.size * s),
      lineHeight: String(TEXT_LINE),
      textAlign: st.align ?? 'left',
      textDecoration: st.underline ? 'underline' : 'none',
      color: ed.color,
      width: `${b.w * s}px`,
      height: `${b.h * s}px`,
    });
    this.showTextBar({ minX: ed.x, minY: ed.y, maxX: ed.x + b.w }, { style: st, size: ed.size, color: ed.color }, 0);
  }

  /** The format bar above a text box (or above the select bar, for selected text boxes). */
  private showTextBar(box: { minX: number; minY: number; maxX: number }, f: { style: TextStyle; size: number; color: string }, above: number) {
    if (!this.textBar) {
      this.textBar = createTextBar((patch) => this.formatText(patch));
      this.area.append(this.textBar.el);
    }
    this.textBar.update(f);
    const el = this.textBar.el;
    const s = this.scale;
    const w = el.offsetWidth;
    const centre = ((box.minX + box.maxX) / 2 - this.scrollX) * s;
    const top = (box.minY - this.scrollY) * s - above - el.offsetHeight - 10;
    el.style.left = `${Math.max(8, Math.min(centre - w / 2, this.viewW - w - 8))}px`;
    // No room above (top of the view): put it below the box instead.
    el.style.top = `${top >= 8 ? top : (box.minY - this.scrollY) * s + 8 + (this.editor ? this.editor.el.offsetHeight : 0) + 8}px`;
  }
  private hideTextBar() {
    this.textBar?.el.remove();
    this.textBar = null;
  }

  /** Selected boxes that are all text (and at least one): the format bar applies to them. */
  private selectedText(): Cached[] | null {
    if (!this.selection.size) return null;
    const list = [...this.selection];
    return list.every((c) => c.s.tool === 'text') ? list : null;
  }

  /**
   * Apply a format change from the bar (or a shortcut): to the text box being typed, or else to the
   * selected text boxes (one undo step). Either way it becomes the style for new text boxes.
   */
  formatText(patch: TextFormatPatch) {
    const { size, color, ...stylePatch } = patch;
    const ed = this.editor;
    if (ed) {
      ed.style = cleanStyle({ ...ed.style, ...stylePatch });
      if (size != null) ed.size = size;
      if (color) ed.color = color;
      this.positionEditor();
      if (document.activeElement !== ed.el) ed.el.focus({ preventScroll: true });
      this.cb.onTextFormat?.({ style: ed.style, size: ed.size, color: ed.color });
      return;
    }
    const sel = this.selectedText();
    if (!sel) return;
    const before = sel.map((c) => c.s);
    const after = before.map((s): Stroke => {
      const font = cleanStyle({ ...s.font, ...stylePatch });
      const { font: _old, ...rest } = s;
      return { ...rest, ...(isPlain(font) ? {} : { font }), width: size ?? s.width, color: color ?? s.color };
    });
    this.replaceCached(before, after);
    this.cb.onStrokesReplaced(before, after);
    const first = after[0];
    this.cb.onTextFormat?.({ style: cleanStyle(first.font), size: first.width, color: first.color });
  }

  /** Text boxes measured before their font had loaded: size them again. */
  private remeasureText() {
    for (const c of this.strokes) {
      if (c.s.tool !== 'text') continue;
      const b = textBox(c.s.text ?? '', c.s.width, c.s.font);
      c.maxX = c.minX + b.w;
      c.maxY = c.minY + b.h;
    }
    this.positionEditor();
    this.invalidate('ink', 'live');
  }

  /** Save a text box that is still being typed (e.g. the page is about to close). */
  finishText() {
    this.commitText();
  }

  /** Remove the editor without saving. */
  private closeEditor() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.el.remove();
    this.hideTextBar();
    this.invalidate('ink', 'live');
  }

  /** Save what was typed: a new text box, an edit (replace), or a removal when emptied. */
  private commitText() {
    const ed = this.editor;
    if (!ed) return;
    // The database keeps up to MAX_TEXT characters per box; never send more (it would be refused,
    // and an edit would already have queued the old box's removal).
    const text = ed.el.value.replace(/\s+$/, '').slice(0, MAX_TEXT);
    this.closeEditor();
    const old = ed.original;
    const style = cleanStyle(ed.style);
    const same = (a: TextStyle, b: TextStyle) => JSON.stringify(cleanStyle(a)) === JSON.stringify(cleanStyle(b));
    if (old && text === old.s.text && ed.size === old.s.width && ed.color === old.s.color && same(style, old.s.font ?? {})) return;
    if (old) {
      this.strokes = this.strokes.filter((c) => c !== old);
      this.byId.delete(old.s.id);
    }
    if (!text) {
      if (old) this.cb.onStrokesRemoved([old.s]);
      return;
    }
    const stroke: Stroke = {
      id: uuid(),
      note_id: this.noteId,
      tool: 'text',
      color: ed.color,
      width: ed.size,
      points: [Math.round(ed.x * 10) / 10, Math.round(ed.y * 10) / 10, 0],
      text,
      ...(isPlain(style) ? {} : { font: style }),
      created_at: old?.s.created_at ?? new Date().toISOString(),
    };
    this.cache(stroke);
    this.invalidate('ink', 'bg', 'margin');
    if (old) this.cb.onStrokesReplaced([old.s], [stroke]);
    else this.cb.onStrokesAdded([stroke]);
  }

  // ----------------------------- selection -----------------------------

  hasSelection() {
    return this.selection.size > 0;
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.invalidate('ink', 'live');
  }

  private selectionBox() {
    if (!this.selection.size) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.selection) {
      minX = Math.min(minX, c.minX);
      minY = Math.min(minY, c.minY);
      maxX = Math.max(maxX, c.maxX);
      maxY = Math.max(maxY, c.maxY);
    }
    const pad = 6;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  /** A loop selects strokes that are mostly inside it; a tap selects the stroke under it. */
  private finishLasso(poly: number[]) {
    this.invalidate('live');
    let w = 0, h = 0;
    for (let i = 2; i < poly.length; i += 2) {
      w = Math.max(w, Math.abs(poly[i] - poly[0]));
      h = Math.max(h, Math.abs(poly[i + 1] - poly[1]));
    }
    if (poly.length < 8 || (w < 8 && h < 8)) {
      const hit = [...this.strokes].reverse().find((c) => this.strokeHit(c, poly[0], poly[1], 6));
      if (hit) this.selection = new Set([hit]);
      this.invalidate('ink', 'live');
      return;
    }
    // Anything the loop or box touches is selected: a point inside it, or a line crossing its edge.
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      px0 = Math.min(px0, poly[i]);
      py0 = Math.min(py0, poly[i + 1]);
      px1 = Math.max(px1, poly[i]);
      py1 = Math.max(py1, poly[i + 1]);
    }
    for (const c of this.strokes) {
      if (c.maxX < px0 || c.minX > px1 || c.maxY < py0 || c.minY > py1) continue;
      if (this.touches(c, poly)) this.selection.add(c);
    }
    this.invalidate('ink', 'live');
  }

  private touches(c: Cached, poly: number[]): boolean {
    if (c.s.tool === 'text' || c.s.tool === 'image') {
      // A box: a corner inside the loop, the loop inside the box, or the outlines crossing.
      const box = [c.minX, c.minY, c.maxX, c.minY, c.maxX, c.maxY, c.minX, c.maxY];
      for (let i = 0; i < 8; i += 2) if (inPolygon(poly, box[i], box[i + 1])) return true;
      if (inPolygon(box, poly[0], poly[1])) return true;
      return crossesOutline([...box, box[0], box[1]], poly);
    }
    const p = c.s.points;
    const n = p.length / 3;
    const step = Math.max(1, Math.floor(n / 200));
    const line: number[] = [];
    for (let i = 0; i < n; i += step) {
      if (inPolygon(poly, p[i * 3], p[i * 3 + 1])) return true;
      line.push(p[i * 3], p[i * 3 + 1]);
    }
    line.push(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    return crossesOutline(line, poly);
  }

  /** Select these strokes (e.g. a picture just inserted). */
  select(ids: string[]) {
    this.selection = new Set(ids.map((id) => this.byId.get(id)).filter((c): c is Cached => !!c));
    this.invalidate('ink', 'live');
  }

  private finishScale(f: number, ax: number, ay: number) {
    this.invalidate('ink', 'live');
    if (Math.abs(f - 1) < 0.01) return;
    const before = [...this.selection].map((c) => c.s);
    const after = before.map((st) => scaled(st, ax, ay, f));
    this.replaceCached(before, after);
    this.cb.onStrokesReplaced(before, after);
  }

  /** The resize handle sits on the selection's bottom-right corner. */
  private onHandle(x: number, y: number): boolean {
    const b = this.selectionBox();
    if (!b) return false;
    return Math.hypot(x - b.maxX, y - b.maxY) <= 18 / this.scale;
  }

  // ----------------------------- pictures -----------------------------

  /** Where a picture of this pixel size goes: centred in the view, at most 600 wide and 80% of the view tall. */
  private placeBox(pxW: number, pxH: number, offset = 0) {
    let w = Math.min(600, (pxW * PAGE_W) / Math.max(1, this.viewW));
    let h = (w * pxH) / Math.max(1, pxW);
    const maxH = (this.viewH / this.scale) * 0.8;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    const cx = this.scrollX + this.viewW / this.scale / 2 + offset;
    const cy = this.scrollY + this.viewH / this.scale / 2 + offset;
    return { l: Math.max(4, Math.min(PAGE_W - w - 4, cx - w / 2)), t: Math.max(4, cy - h / 2), w, h };
  }

  /**
   * Show a placeholder where a picture is about to appear, before it is ready (preparing, encrypting
   * and uploading can take a moment). The size is a guess until `sizePending` gives the real one.
   */
  addPending(): number {
    const key = ++this.pendingSeq;
    const offset = this.pending.size * 24; // several at once step down-right, like a stack
    this.pending.set(key, { ...this.placeBox(800, 600, offset), offset });
    this.area.setAttribute('aria-busy', 'true');
    this.invalidate('live');
    return key;
  }
  sizePending(key: number, pxW: number, pxH: number) {
    const p = this.pending.get(key);
    if (!p) return;
    // Take the picture's proportions, keeping the box where it is (the view may have moved since).
    const { w, h } = this.placeBox(pxW, pxH);
    const cx = p.l + p.w / 2, cy = p.t + p.h / 2;
    this.pending.set(key, { l: Math.max(4, Math.min(PAGE_W - w - 4, cx - w / 2)), t: Math.max(4, cy - h / 2), w, h, offset: p.offset });
    this.invalidate('live');
  }
  removePending(key: number) {
    this.pending.delete(key);
    if (!this.pending.size) this.area.removeAttribute('aria-busy');
    this.invalidate('live');
  }

  /** Place a picture in the middle of the view, at most 600 page units wide, and select it. */
  insertImage(id: string, type: string, bitmap: ImageBitmap, slot?: number): Stroke {
    this.commitText();
    // Into the placeholder the user was shown, if there is one; otherwise the middle of the view.
    const { l, t, w, h } = (slot != null && this.pending.get(slot)) || this.placeBox(bitmap.width, bitmap.height);
    if (slot != null) this.removePending(slot);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const stroke: Stroke = {
      id: uuid(),
      note_id: this.noteId,
      tool: 'image',
      color: type,
      width: 1,
      points: [r1(l), r1(t), 0, r1(l + w), r1(t + h), 0],
      text: id,
      created_at: new Date().toISOString(),
    };
    this.images.set(id, bitmap);
    this.cache(stroke);
    this.invalidate('ink', 'bg', 'margin');
    this.cb.onStrokesAdded([stroke]);
    return stroke;
  }

  /** The picture for an image stroke, starting to load it if needed. */
  private imageFor(s: Stroke): ImageBitmap | 'loading' | 'error' {
    const id = s.text ?? '';
    const have = this.images.get(id);
    if (have) return have;
    this.images.set(id, 'loading');
    const load = this.cb.loadImage;
    if (!load) {
      this.images.set(id, 'error');
      return 'error';
    }
    load(id, s.color)
      .then((blob) => createImageBitmap(blob))
      .then((bm) => this.images.set(id, bm))
      .catch((e) => {
        console.warn('Picture not loaded', e);
        this.images.set(id, 'error');
      })
      .finally(() => this.invalidate('ink'));
    return 'loading';
  }

  /** Wait for every picture on the page (before exporting). */
  private async allImagesLoaded() {
    for (const c of this.strokes) if (c.s.tool === 'image') this.imageFor(c.s);
    for (let i = 0; i < 100 && [...this.images.values()].includes('loading'); i++) await new Promise((r) => setTimeout(r, 50));
  }

  private finishMove(dx: number, dy: number) {
    this.invalidate('ink', 'live');
    if (Math.hypot(dx, dy) < 1) return;
    const before = [...this.selection].map((c) => c.s);
    const after = before.map((s) => moved(s, dx, dy));
    this.replaceCached(before, after);
    this.cb.onStrokesReplaced(before, after);
  }

  /** Swap cached strokes for new versions and keep them selected. */
  private replaceCached(before: Stroke[], after: Stroke[]) {
    const ids = new Set(before.map((s) => s.id));
    this.strokes = this.strokes.filter((c) => !ids.has(c.s.id));
    for (const id of ids) this.byId.delete(id);
    this.selection = new Set(after.map((s) => this.cache(s)));
    this.invalidate('ink', 'bg', 'live', 'margin');
  }

  deleteSelection() {
    if (!this.selection.size) return;
    const gone = [...this.selection];
    const ids = new Set(gone.map((c) => c.s.id));
    this.strokes = this.strokes.filter((c) => !ids.has(c.s.id));
    for (const id of ids) this.byId.delete(id);
    this.selection.clear();
    this.invalidate('ink', 'live');
    this.cb.onStrokesRemoved(gone.map((c) => c.s));
  }

  duplicateSelection() {
    if (!this.selection.size) return;
    const copies = [...this.selection].map((c) => moved(c.s, 24, 24, uuid()));
    for (const s of copies) s.created_at = new Date().toISOString();
    this.selection = new Set(copies.map((s) => this.cache(s)));
    this.invalidate('ink', 'bg', 'live', 'margin');
    this.cb.onStrokesAdded(copies);
  }

  /** The Delete / Duplicate bar floats above the selection. */
  private positionSelectBar(box: { minX: number; minY: number; maxX: number } | null) {
    if (!box || this.active?.kind === 'move' || this.active?.kind === 'scale') {
      this.selectBar?.remove();
      this.selectBar = null;
      if (!this.editor) this.hideTextBar();
      return;
    }
    if (!this.selectBar) {
      const bar = document.createElement('div');
      bar.className = 'select-bar';
      const btn = (label: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', fn);
        return b;
      };
      bar.append(btn('Duplicate', () => this.duplicateSelection()), btn('Delete', () => this.deleteSelection()));
      this.area.append(bar);
      this.selectBar = bar;
    }
    const s = this.scale;
    const left = ((box.minX + box.maxX) / 2 - this.scrollX) * s;
    const top = (box.minY - this.scrollY) * s;
    this.selectBar.style.left = `${Math.max(8, Math.min(left, this.viewW - 8))}px`;
    this.selectBar.style.top = `${Math.max(8, top - 46)}px`;
    // Only text boxes selected: their format bar sits above the Duplicate / Delete bar.
    const text = this.editor ? null : this.selectedText();
    if (text) {
      const first = text[0].s;
      this.showTextBar(box, { style: cleanStyle(first.font), size: first.width, color: first.color }, 46);
    } else if (!this.editor) this.hideTextBar();
  }

  /** A shape outline as a pen stroke, in the palette's colour, thickness and line style. */
  private shapeStroke(points: number[]): Stroke {
    const dash = this.settings.shapeDash;
    return { id: '', note_id: '', tool: 'pen', color: this.settings.penColor, width: this.settings.shapeWidth, points, ...(dash !== 'solid' ? { dash } : {}) };
  }

  /** The strokes of the shape being dragged (the proportions switch or Shift keeps it square). */
  private shapeOf(a: ActiveInput): number[][] {
    const sh = a.shape!;
    return shapeStrokes(this.settings.shape, sh.x0, sh.y0, sh.x1, sh.y1, sh.constrain || this.settings.shapeLock);
  }

  private cancelActive() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.kind === 'erase' && a.erased.length) {
      // Palm or cancel during erase: put the strokes back.
      for (const c of a.erased) {
        this.strokes.push(c);
        this.byId.set(c.s.id, c);
      }
      this.invalidate('ink');
    }
    this.invalidate('live');
  }

  private finish() {
    const a = this.active!;
    this.active = null;
    if (a.lasso) return this.finishLasso(a.lasso);
    if (a.rect) {
      const { x0, y0, x1, y1 } = a.rect;
      return this.finishLasso([x0, y0, x1, y0, x1, y1, x0, y1]); // same "mostly inside" rule; a tap picks one
    }
    if (a.move) return this.finishMove(a.move.dx, a.move.dy);
    if (a.scale) return this.finishScale(a.scale.f, a.scale.ax, a.scale.ay);
    if (a.kind === 'erase') {
      if (this.tool === 'eraser' && a.pointerType !== 'mouse') this.eraserCursor = null;
      if (a.erased.length) this.cb.onStrokesRemoved(a.erased.map((c) => c.s));
      this.invalidate('live');
      return;
    }
    if (a.shape) {
      const { x0, y0, x1, y1 } = a.shape;
      this.invalidate('ink', 'live');
      if (Math.hypot(x1 - x0, y1 - y0) < 3) return; // a tap, not a shape
      // Shapes are pen strokes (see shapes.ts); some, like a crossed box, are several.
      const parts = this.shapeOf(a).filter((p) => p.length);
      const now = new Date().toISOString();
      const made = parts.map((points): Stroke => ({ ...this.shapeStroke(points), id: uuid(), note_id: this.noteId, created_at: now }));
      for (const st of made) this.cache(st);
      if (made.length) this.cb.onStrokesAdded(made); // one undo step for the whole shape
      return;
    }
    if (!a.points.length) return;
    // Finish where the pen actually lifted (the stabilizer trails slightly behind it).
    if (a.raw && this.settings.smoothing > 0 && a.points.length >= 3) {
      const [x, y, p] = a.raw;
      const n = a.points.length;
      if (Math.hypot(x - a.points[n - 3], y - a.points[n - 2]) >= MIN_POINT_DIST) a.points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
    }
    const isHL = this.tool === 'highlighter';
    const stroke: Stroke = {
      id: uuid(),
      note_id: this.noteId,
      tool: isHL ? 'highlighter' : 'pen',
      color: isHL ? this.settings.highlighterColor : this.settings.penColor,
      width: isHL ? this.settings.highlighterWidth : this.settings.penWidth,
      points: a.points,
      created_at: new Date().toISOString(),
    };
    this.cache(stroke);
    this.invalidate('ink', 'live');
    this.cb.onStrokesAdded([stroke]);
  }

  // ----------------------------- rendering -----------------------------

  private resize() {
    const w = this.area.clientWidth;
    const h = this.area.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.viewW = w;
    this.viewH = h;
    this.baseScale = w / PAGE_W;
    this.scale = this.baseScale * this.zoom;
    for (const c of [this.bg, this.ink, this.live]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.setScroll(this.scrollY);
    this.invalidate('bg', 'ink', 'live', 'margin');
  }

  private invalidate(...what: (keyof Board['dirty'])[]) {
    for (const w of what) this.dirty[w] = true;
    if (!this.rafId) this.rafId = requestAnimationFrame(() => this.frame());
  }

  private frame() {
    this.rafId = 0;
    const d = this.dirty;
    if (d.bg) this.drawBg();
    if (d.ink) this.drawInk();
    if (d.live) this.drawLive();
    if (d.margin) this.drawMargin();
    this.dirty = { bg: false, ink: false, live: false, margin: false };
    // Placeholders for pictures being added shimmer, so keep drawing while any are shown.
    if (this.pending.size && !REDUCED_MOTION()) this.invalidate('live');
  }

  private visibleStrips(): [number, number] {
    const H = this.settings.stripHeight;
    const first = Math.floor(this.scrollY / H);
    const last = Math.floor((this.scrollY + this.viewH / this.scale) / H);
    return [first, last];
  }

  private drawBg() {
    const ctx = this.bgCtx;
    const { dpr, scale: s } = this;
    const H = this.settings.stripHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.free) {
      // Whiteboard: white page, no strips or locks, with the chosen paper.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      this.drawPaper(ctx);
      return;
    }
    if (this.split) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      if (this.settings.showLines) {
        const [first, last] = this.visibleStrips();
        ctx.strokeStyle = '#dde3ea';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = first; i <= last; i++) {
          const y = Math.round(((i + 1) * H - this.scrollY) * s) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(this.viewW, y);
        }
        ctx.stroke();
      }
      return;
    }
    ctx.fillStyle = '#eef0f3';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    const [first, last] = this.visibleStrips();
    for (let i = first; i <= last; i++) {
      const top = (i * H - this.scrollY) * s;
      const hpx = H * s;
      if (this.unlocked.has(i)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, top, this.viewW, hpx);
      }
      if (this.settings.showLines) {
        ctx.strokeStyle = '#cfd6e0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const y = Math.round(top + hpx) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.viewW, y);
        ctx.stroke();
      }
    }
    // Outline the unlocked strips.
    for (const i of this.unlocked) {
      if (i < first || i > last) continue;
      const top = (i * H - this.scrollY) * s;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, top + 1, this.viewW - 2, H * s - 2);
    }
  }

  /** Free whiteboard paper: ruled lines, a grid or dots that scroll and zoom with the page. */
  private drawPaper(ctx: CanvasRenderingContext2D) {
    const paper = this.settings.paper;
    if (paper === 'plain') return;
    const s = this.scale;
    const gap = paper === 'lines' ? this.settings.stripHeight / 2 : 40; // page units
    const x0 = Math.floor(this.scrollX / gap) * gap;
    const y0 = Math.floor(this.scrollY / gap) * gap;
    const x1 = this.scrollX + this.viewW / s;
    const y1 = this.scrollY + this.viewH / s;
    const sx = (x: number) => Math.round((x - this.scrollX) * s) + 0.5;
    const sy = (y: number) => Math.round((y - this.scrollY) * s) + 0.5;
    if (paper === 'dots') {
      ctx.fillStyle = '#c3cbd6';
      const r = Math.max(1, 1.2 * Math.min(2, s));
      for (let y = y0; y <= y1; y += gap) for (let x = x0; x <= x1; x += gap) ctx.fillRect(sx(x) - r / 2, sy(y) - r / 2, r, r);
      return;
    }
    ctx.strokeStyle = '#e1e6ed';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = y0; y <= y1; y += gap) {
      ctx.moveTo(0, sy(y));
      ctx.lineTo(this.viewW, sy(y));
    }
    if (paper === 'grid')
      for (let x = x0; x <= x1; x += gap) {
        ctx.moveTo(sx(x), 0);
        ctx.lineTo(sx(x), this.viewH);
      }
    ctx.stroke();
  }

  private setPageTransform(ctx: CanvasRenderingContext2D) {
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, -this.scrollX * k, -this.scrollY * k);
  }

  private drawInk() {
    const ctx = this.inkCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    this.setPageTransform(ctx);
    const y0 = this.scrollY;
    const y1 = this.scrollY + this.viewH / this.scale;
    const hidden = this.editor?.original;
    const dragging = this.active?.kind === 'move' || this.active?.kind === 'scale';
    // Pictures first, so ink is always drawn on top of them.
    for (const pass of [true, false])
      for (const c of this.strokes) {
        if ((c.s.tool === 'image') !== pass) continue;
        if (c.maxY < y0 || c.minY > y1 || c === hidden || (dragging && this.selection.has(c))) continue;
        this.drawStroke(ctx, c);
      }
  }

  private drawStroke(ctx: CanvasRenderingContext2D, c: Cached) {
    const s = c.s;
    if (s.tool === 'image') {
      const img = this.imageFor(s);
      const w = c.maxX - c.minX, h = c.maxY - c.minY;
      if (img !== 'loading' && img !== 'error') {
        ctx.drawImage(img, c.minX, c.minY, w, h);
        return;
      }
      drawSkeleton(ctx, c.minX, c.minY, w, h, img === 'error' ? 'Picture unavailable' : 'Loading picture…', null, this.scale);
      return;
    }
    if (s.tool === 'text') {
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.strokeStyle = s.color;
      ctx.font = fontCss(s.font, s.width);
      ctx.textBaseline = 'top';
      const lines = (s.text ?? '').split('\n');
      // Centre each line in its line box, matching the textarea's layout.
      const pad = (s.width * (TEXT_LINE - 1)) / 2;
      const boxW = c.maxX - c.minX;
      const k = s.font?.align === 'right' ? 1 : s.font?.align === 'center' ? 0.5 : 0;
      lines.forEach((l, i) => {
        const lw = ctx.measureText(l).width;
        const x = s.points[0] + (boxW - lw) * k;
        const y = s.points[1] + pad + i * s.width * TEXT_LINE;
        ctx.fillText(l, x, y);
        if (s.font?.underline && lw > 0) {
          ctx.lineWidth = Math.max(1 / this.scale, s.width / 15);
          ctx.beginPath();
          ctx.moveTo(x, y + s.width * 0.98);
          ctx.lineTo(x + lw, y + s.width * 0.98);
          ctx.stroke();
        }
      });
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    if (s.tool === 'highlighter') {
      ctx.globalAlpha = 0.38;
      ctx.globalCompositeOperation = 'multiply';
    }
    if (c.variable) {
      const p = s.points;
      for (let i = 3; i < p.length; i += 3) {
        ctx.lineWidth = s.width * pressureFactor((p[i - 1] + p[i + 2]) / 2);
        ctx.beginPath();
        ctx.moveTo(p[i - 3], p[i - 2]);
        ctx.lineTo(p[i], p[i + 1]);
        ctx.stroke();
      }
    } else if (s.dash) {
      // Each side starts a fresh pattern, so corners are drawn; short pieces (arrowheads, the
      // sides of a tiny shape) stay solid rather than breaking up.
      ctx.lineWidth = s.width;
      const pattern = s.dash === 'dotted' ? [0, s.width * 1.8 + 2] : [s.width * 2.5 + 4, s.width * 2 + 3];
      const solidBelow = Math.max(30, pattern[0] * 2 + pattern[1]); // arrowheads are at most 28 long
      for (const pc of (c.pieces ??= dashPieces(s.points))) {
        ctx.setLineDash(pc.len < solidBelow ? [] : pattern);
        ctx.stroke(pc.path);
      }
    } else {
      if (!c.path) c.path = buildPath(s.points);
      ctx.lineWidth = s.width;
      ctx.stroke(c.path);
    }
    ctx.restore();
  }

  private drawLive() {
    this.positionEditor();
    const ctx = this.liveCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (this.split) this.drawSplitOverlay(ctx);
    this.setPageTransform(ctx);
    const a = this.active;
    const phase = REDUCED_MOTION() ? null : (performance.now() % 1400) / 1400;
    for (const p of this.pending.values()) drawSkeleton(ctx, p.l, p.t, p.w, p.h, 'Adding picture…', phase, this.scale);
    if (a?.shape) {
      for (const points of this.shapeOf(a)) {
        if (!points.length) continue;
        this.drawStroke(ctx, { s: this.shapeStroke(points), minX: 0, minY: 0, maxX: 0, maxY: 0, variable: false, path: null });
      }
    } else if (a && a.kind === 'draw' && a.points.length) {
      const isHL = this.tool === 'highlighter';
      const tmp: Stroke = {
        id: '',
        note_id: '',
        tool: isHL ? 'highlighter' : 'pen',
        color: isHL ? this.settings.highlighterColor : this.settings.penColor,
        width: isHL ? this.settings.highlighterWidth : this.settings.penWidth,
        points: a.points,
      };
      let pmin = 1,
        pmax = 0;
      for (let i = 2; i < tmp.points.length; i += 3) {
        pmin = Math.min(pmin, tmp.points[i]);
        pmax = Math.max(pmax, tmp.points[i]);
      }
      this.drawStroke(ctx, { s: tmp, minX: 0, minY: 0, maxX: 0, maxY: 0, variable: !isHL && pmax - pmin > 0.05, path: null });
    }
    if (a?.rect) {
      const { x0, y0, x1, y1 } = a.rect;
      ctx.save();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([6 / this.scale, 5 / this.scale]);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#2563eb';
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.restore();
    }
    if (a?.lasso && a.lasso.length >= 4) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.lasso[0], a.lasso[1]);
      for (let i = 2; i < a.lasso.length; i += 2) ctx.lineTo(a.lasso[i], a.lasso[i + 1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.06)';
      ctx.fill();
      ctx.setLineDash([6 / this.scale, 5 / this.scale]);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#2563eb';
      ctx.stroke();
      ctx.restore();
    }
    let box = this.selectionBox();
    if (box && a?.scale) {
      // Resizing: draw the selection at its new size (pictures underneath ink, as on the page).
      const { ax, ay, f } = a.scale;
      const preview = [...this.selection].map((c) => ({ ...c, s: scaled(c.s, ax, ay, f), path: null, pieces: undefined }));
      for (const pass of [true, false])
        for (const c of preview) {
          if ((c.s.tool === 'image') !== pass) continue;
          const p = c.s.points;
          if (c.s.tool === 'image') Object.assign(c, { minX: p[0], minY: p[1], maxX: p[3], maxY: p[4] });
          this.drawStroke(ctx, c);
        }
      box = { minX: ax + (box.minX - ax) * f, minY: ay + (box.minY - ay) * f, maxX: ax + (box.maxX - ax) * f, maxY: ay + (box.maxY - ay) * f };
    }
    if (box) {
      const dx = a?.move?.dx ?? 0;
      const dy = a?.move?.dy ?? 0;
      ctx.save();
      ctx.translate(dx, dy);
      if (a?.move)
        for (const pass of [true, false]) for (const c of this.selection) if ((c.s.tool === 'image') === pass) this.drawStroke(ctx, c);
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#2563eb';
      ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
      // Resize handle.
      const hs = 7 / this.scale;
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(box.maxX - hs, box.maxY - hs, hs * 2, hs * 2);
      ctx.strokeRect(box.maxX - hs, box.maxY - hs, hs * 2, hs * 2);
      ctx.restore();
    }
    this.positionSelectBar(box);
    if (this.tool === 'eraser' && this.eraserCursor) {
      ctx.beginPath();
      ctx.arc(this.eraserCursor.x, this.eraserCursor.y, ERASER_RADIUS, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 / this.scale;
      ctx.strokeStyle = '#6b7280';
      ctx.stroke();
    }
  }

  /** Split mode: a tinted mask over each locked pane (the page still shows through) and the divider. */
  private drawSplitOverlay(ctx: CanvasRenderingContext2D) {
    const d = this.dividerY;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.55)';
    if (!this.panes.top) ctx.fillRect(0, 0, this.viewW, d);
    if (!this.panes.bottom) ctx.fillRect(0, d, this.viewW, this.viewH - d);
    ctx.fillStyle = this.dividerArmed ? '#2563eb' : '#94a3b8';
    ctx.fillRect(0, Math.round(d) - (this.dividerArmed ? 1.5 : 1), this.viewW, this.dividerArmed ? 3 : 2);
  }

  private drawMargin() {
    if (this.free) {
      this.margin.replaceChildren(); // hidden in free mode
      return;
    }
    if (this.split) {
      const d = this.dividerY;
      const pane = (which: 'top' | 'bottom', top: number, height: number) => {
        const on = this.panes[which];
        const el = document.createElement('div');
        el.className = 'strip-btn split-pane' + (on ? ' on' : '');
        el.style.top = top + 'px';
        el.style.height = height + 'px';
        el.innerHTML = on ? UNLOCK_SVG : LOCK_SVG;
        el.setAttribute('aria-label', `${on ? 'Lock' : 'Unlock'} ${which} pane`);
        return el;
      };
      const grip = document.createElement('div');
      grip.className = 'split-grip' + (this.dividerArmed ? ' armed' : '');
      grip.style.top = d - SPLIT_GRIP / 2 + 'px';
      grip.style.height = SPLIT_GRIP + 'px';
      grip.innerHTML = GRIP_SVG;
      grip.setAttribute('aria-label', this.dividerArmed ? 'Divider ready: drag in the margin to move it' : 'Divider: tap, then drag to move');
      this.margin.replaceChildren(pane('top', 0, d), pane('bottom', d, this.viewH - d), grip);
      return;
    }
    const H = this.settings.stripHeight;
    const s = this.scale;
    const [first, last] = this.visibleStrips();
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const d = document.createElement('div');
      const on = this.unlocked.has(i);
      d.className = 'strip-btn' + (on ? ' on' : '');
      d.style.top = (i * H - this.scrollY) * s + 'px';
      d.style.height = H * s + 'px';
      d.innerHTML = on ? UNLOCK_SVG : LOCK_SVG;
      d.setAttribute('aria-label', (on ? 'Lock' : 'Unlock') + ' strip ' + (i + 1));
      frag.append(d);
    }
    this.margin.replaceChildren(frag);
  }
}

const REDUCED_MOTION = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A grey box standing in for a picture that is not there yet, with a label in the middle. With a
 * `phase` (0..1) a light band sweeps across it, so it reads as something in progress.
 */
function drawSkeleton(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, phase: number | null, scale: number) {
  ctx.save();
  const r = Math.min(10, w / 4, h / 4);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = '#eef2f7';
  ctx.fill();
  if (phase != null) {
    ctx.save();
    ctx.clip();
    const band = Math.max(60, w * 0.35);
    const bx = x - band + (w + 2 * band) * phase;
    const g = ctx.createLinearGradient(bx, 0, bx + band, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1 / scale;
  ctx.stroke();
  // The label stays a readable size on screen, and is left out when the box is too small for it.
  const font = 14 / scale;
  ctx.font = `${font}px ${TEXT_FONT}`;
  if (ctx.measureText(label).width < w - 16 / scale && font * 2 < h) {
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
  }
  ctx.restore();
}

/** Split a stroke at its corners (a repeated point, see shapes.ts) into separately dashed pieces. */
function dashPieces(p: number[]): { path: Path2D; len: number }[] {
  const out: { path: Path2D; len: number }[] = [];
  let start = 0;
  const n = p.length / 3;
  for (let i = 1; i <= n; i++) {
    const corner = i === n || (p[i * 3] === p[(i - 1) * 3] && p[i * 3 + 1] === p[(i - 1) * 3 + 1]);
    if (!corner) continue;
    const piece = p.slice(start * 3, i * 3);
    if (piece.length >= 6) {
      let len = 0;
      for (let k = 3; k < piece.length; k += 3) len += Math.hypot(piece[k] - piece[k - 3], piece[k + 1] - piece[k - 2]);
      out.push({ path: buildPath(piece), len });
    }
    start = i;
  }
  return out;
}

function buildPath(p: number[]): Path2D {
  const path = new Path2D();
  const n = p.length / 3;
  path.moveTo(p[0], p[1]);
  if (n === 1) {
    path.lineTo(p[0] + 0.01, p[1]);
    return path;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 3],
      y = p[i * 3 + 1];
    const nx = p[(i + 1) * 3],
      ny = p[(i + 1) * 3 + 1];
    path.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  path.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  return path;
}
