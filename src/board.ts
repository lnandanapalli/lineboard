import type { Settings, Stroke, Tool } from './types';
import { uuid } from './util';
import { appRect, clientToApp, deltaToApp } from './orientation';
import { shapePoints } from './shapes';

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
  /** Reports every contact that touches the drawing area (used for calibration readout). */
  onContact(size: number, pointerType: string, accepted: boolean): void;
  onUnlockChange(unlocked: number[]): void;
  /** Split mode: the divider was moved (fraction of the board's height). */
  onSplitRatio?(ratio: number): void;
}

interface Cached {
  s: Stroke;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  variable: boolean;
  path: Path2D | null;
}

interface ActiveInput {
  pointerId: number;
  pointerType: string;
  kind: 'draw' | 'erase' | 'shape';
  start: number;
  points: number[];
  erased: Cached[];
  /** The latest raw (unsmoothed) input point, so the stroke can end exactly where the pen lifted. */
  raw: [number, number, number] | null;
  /** Shape tool: where the drag started, where it is now, and whether Shift is held. */
  shape?: { x0: number; y0: number; x1: number; y1: number; constrain: boolean };
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
let measureCtx: CanvasRenderingContext2D | null = null;
/** Width and height (page units) of a text box. */
function textBox(text: string, size: number) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = `${size}px ${TEXT_FONT}`;
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
  /** Text box being typed (new, or editing an existing one). */
  private editor: { el: HTMLTextAreaElement; x: number; y: number; size: number; color: string; original: Cached | null } | null = null;

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
    new ResizeObserver(() => this.resize()).observe(this.area);
    this.resize();
  }

  // ----------------------------- public API -----------------------------

  setStrokes(noteId: string, strokes: Stroke[]) {
    this.commitText();
    this.cancelActive();
    this.noteId = noteId;
    this.strokes = [];
    this.byId.clear();
    for (const s of strokes) this.cache(s);
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
    for (const cs of this.strokes) this.drawStroke(ctx, cs);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export failed'))), 'image/png'));
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  // ----------------------------- geometry -----------------------------

  private cache(s: Stroke): Cached {
    if (s.tool === 'text') {
      const b = textBox(s.text ?? '', s.width);
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
      if (e.target instanceof HTMLTextAreaElement) return; // let the text box take taps (caret, selection)
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
      if (hit) this.openEditor(hit.s.points[0], hit.s.points[1], hit.s.width, hit.s.color, hit);
      // The tap marks where the first line is, so the caret sits under the pen.
      else this.openEditor(pt.x, pt.y - this.settings.textSize * 0.6, this.settings.textSize, this.settings.penColor, null);
      return;
    }

    e.preventDefault();
    try {
      this.live.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
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
      if (x < c.minX - r || x > c.maxX + r || y < c.minY - r || y > c.maxY + r) continue;
      if (this.strokeHit(c, x, y, r)) hit.push(c);
    }
    if (!hit.length) return;
    const ids = new Set(hit.map((h) => h.s.id));
    this.strokes = this.strokes.filter((c) => !ids.has(c.s.id));
    for (const h of hit) this.byId.delete(h.s.id);
    a.erased.push(...hit);
    this.invalidate('ink');
  }

  private strokeHit(c: Cached, x: number, y: number, r: number): boolean {
    if (c.s.tool === 'text') return x >= c.minX - r && x <= c.maxX + r && y >= c.minY - r && y <= c.maxY + r;
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

  private openEditor(x: number, y: number, size: number, color: string, original: Cached | null) {
    const el = document.createElement('textarea');
    el.className = 'text-editor';
    el.setAttribute('aria-label', 'Text');
    el.spellcheck = true;
    el.wrap = 'off';
    el.value = original?.s.text ?? '';
    this.area.append(el);
    this.editor = { el, x, y, size, color, original };
    if (original) this.invalidate('ink'); // hide the original while it is being edited
    el.addEventListener('input', () => this.positionEditor());
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger tool shortcuts
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
    const b = textBox(ed.el.value || ' ', ed.size);
    Object.assign(ed.el.style, {
      left: `${(ed.x - this.scrollX) * s}px`,
      top: `${(ed.y - this.scrollY) * s}px`,
      fontSize: `${ed.size * s}px`,
      lineHeight: String(TEXT_LINE),
      fontFamily: TEXT_FONT,
      color: ed.color,
      width: `${(b.w + ed.size) * s}px`,
      height: `${b.h * s}px`,
    });
  }

  /** Remove the editor without saving. */
  private closeEditor() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.el.remove();
    this.invalidate('ink');
  }

  /** Save what was typed: a new text box, an edit (replace), or a removal when emptied. */
  private commitText() {
    const ed = this.editor;
    if (!ed) return;
    const text = ed.el.value.replace(/\s+$/, '');
    this.closeEditor();
    const old = ed.original;
    if (old && text === old.s.text) return;
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
      created_at: old?.s.created_at ?? new Date().toISOString(),
    };
    this.cache(stroke);
    this.invalidate('ink', 'bg', 'margin');
    if (old) this.cb.onStrokesReplaced([old.s], [stroke]);
    else this.cb.onStrokesAdded([stroke]);
  }

  private shapeOf(a: ActiveInput): number[] {
    const sh = a.shape!;
    return shapePoints(this.settings.shape, sh.x0, sh.y0, sh.x1, sh.y1, sh.constrain);
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
    if (a.kind === 'erase') {
      if (this.tool === 'eraser' && a.pointerType !== 'mouse') this.eraserCursor = null;
      if (a.erased.length) this.cb.onStrokesRemoved(a.erased.map((c) => c.s));
      this.invalidate('live');
      return;
    }
    if (a.shape) {
      const { x0, y0, x1, y1 } = a.shape;
      this.invalidate('live');
      if (Math.hypot(x1 - x0, y1 - y0) < 3) return; // a tap, not a shape
      a.points = this.shapeOf(a);
    }
    if (!a.points.length) return;
    // Finish where the pen actually lifted (the stabilizer trails slightly behind it).
    if (a.raw && this.settings.smoothing > 0 && a.points.length >= 3) {
      const [x, y, p] = a.raw;
      const n = a.points.length;
      if (Math.hypot(x - a.points[n - 3], y - a.points[n - 2]) >= MIN_POINT_DIST) a.points.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
    }
    const isHL = this.tool === 'highlighter';
    // Shapes are pen strokes (see shapes.ts).
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
      // Plain whiteboard: white page, no strips, lines or locks.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.viewW, this.viewH);
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
    for (const c of this.strokes) {
      if (c.maxY < y0 || c.minY > y1 || c === hidden) continue;
      this.drawStroke(ctx, c);
    }
  }

  private drawStroke(ctx: CanvasRenderingContext2D, c: Cached) {
    const s = c.s;
    if (s.tool === 'text') {
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.font = `${s.width}px ${TEXT_FONT}`;
      ctx.textBaseline = 'top';
      const lines = (s.text ?? '').split('\n');
      // Centre each line in its line box, matching the textarea's layout.
      const pad = (s.width * (TEXT_LINE - 1)) / 2;
      lines.forEach((l, i) => ctx.fillText(l, s.points[0], s.points[1] + pad + i * s.width * TEXT_LINE));
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
    const shapePts = a?.shape ? this.shapeOf(a) : null;
    if (a && ((a.kind === 'draw' && a.points.length) || shapePts)) {
      const isHL = this.tool === 'highlighter';
      const tmp: Stroke = {
        id: '',
        note_id: '',
        tool: isHL ? 'highlighter' : 'pen',
        color: isHL ? this.settings.highlighterColor : this.settings.penColor,
        width: isHL ? this.settings.highlighterWidth : this.settings.penWidth,
        points: shapePts ?? a.points,
      };
      let pmin = 1,
        pmax = 0;
      for (let i = 2; i < tmp.points.length; i += 3) {
        pmin = Math.min(pmin, tmp.points[i]);
        pmax = Math.max(pmax, tmp.points[i]);
      }
      this.drawStroke(ctx, { s: tmp, minX: 0, minY: 0, maxX: 0, maxY: 0, variable: !isHL && pmax - pmin > 0.05, path: null });
    }
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
