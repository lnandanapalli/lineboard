/**
 * Shapes are saved as ordinary pen strokes whose points trace the outline, so undo, the eraser,
 * sync and encryption treat them like any other ink. Strokes are drawn as smooth curves through
 * their points; a doubled point makes the curve pass exactly through it, which keeps corners sharp.
 *
 * A shape is drawn by dragging out its box. Perfect shapes don't need a keyboard: a box that is
 * nearly square snaps to an exact square (circle, star...), lines snap to horizontal, vertical and
 * 45°, and the palette's "Keep proportions" switch forces equal sides. Shift does the same on a
 * keyboard.
 */

export const SHAPES = [
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'hexagon',
  'capsule',
  'parallelogram',
  'star',
  'cloud',
  'heart',
  'crossbox',
  'checkbox',
  'arrowLeft',
  'arrowUp',
  'arrowDown',
  'arrowRight',
  'line',
  'arrow',
] as const;
export type ShapeKind = (typeof SHAPES)[number];

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  diamond: 'Diamond',
  hexagon: 'Hexagon',
  capsule: 'Rounded box',
  parallelogram: 'Parallelogram',
  star: 'Star',
  cloud: 'Cloud',
  heart: 'Heart',
  crossbox: 'Crossed box',
  checkbox: 'Check box',
  arrowLeft: 'Left arrow',
  arrowUp: 'Up arrow',
  arrowDown: 'Down arrow',
  arrowRight: 'Right arrow',
  line: 'Line',
  arrow: 'Arrow line',
};

const P = 0.5; // constant pressure: shapes have an even width
const r1 = (v: number) => Math.round(v * 10) / 10;
/** Boxes this close to square (relative difference of the sides) snap to exactly square. */
const SNAP_SQUARE = 0.12;
/** Lines within this many degrees of a multiple of 45° snap to it. */
const SNAP_DEG = 6;

type Pt = [number, number];

/** Polygon in unit-box coordinates (0..1), closed. Corners are doubled to stay sharp. */
const POLYGONS: Partial<Record<ShapeKind, Pt[]>> = {
  rectangle: [[0, 0], [1, 0], [1, 1], [0, 1]],
  triangle: [[0.5, 0], [1, 1], [0, 1]],
  diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
  hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
  parallelogram: [[0.22, 0], [1, 0], [0.78, 1], [0, 1]],
  arrowRight: [[0, 0.3], [0.58, 0.3], [0.58, 0], [1, 0.5], [0.58, 1], [0.58, 0.7], [0, 0.7]],
};

/** Smooth closed outlines in unit-box coordinates, sampled at n points for t in [0, 1). */
const CURVES: Partial<Record<ShapeKind, (t: number) => Pt>> = {
  ellipse: (t) => [0.5 + 0.5 * Math.cos(t * 2 * Math.PI), 0.5 + 0.5 * Math.sin(t * 2 * Math.PI)],
  // Bumps around an ellipse: |sin| makes the dips between bumps pinch inwards, like a cloud.
  cloud: (t) => {
    const a = t * 2 * Math.PI;
    const k = 0.84 + 0.16 * Math.abs(Math.sin(a * 4.5));
    return [0.5 + 0.5 * k * Math.cos(a), 0.5 + 0.5 * k * Math.sin(a)];
  },
  heart: (t) => {
    const a = t * 2 * Math.PI;
    const x = 16 * Math.sin(a) ** 3;
    const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
    // x in [-16, 16], y in about [-17, 12]: fit to the box, top up.
    return [0.5 + x / 32, (12 - y) / 29];
  },
};

/** Equal sides for shapes whose box should be square (any that isn't a line). */
const isLine = (k: ShapeKind) => k === 'line' || k === 'arrow';

/**
 * The strokes (each a flat [x, y, p, ...] list) for a shape dragged from (x0, y0) to (x1, y1).
 * `force` makes the box square / the line snap to 45° (proportions switch or Shift).
 */
export function shapeStrokes(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, force: boolean): number[][] {
  let dx = x1 - x0;
  let dy = y1 - y0;
  if (isLine(kind)) {
    ({ dx, dy } = snapAngle(dx, dy, force));
  } else {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const m = Math.max(ax, ay);
    if (m > 0 && (force || Math.abs(ax - ay) / m < SNAP_SQUARE)) {
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
  }
  const ex = x0 + dx;
  const ey = y0 + dy;
  // The box, left-top to right-bottom, whichever way it was dragged.
  const L = Math.min(x0, ex), T = Math.min(y0, ey), W = Math.abs(dx), H = Math.abs(dy);
  const at = ([u, v]: Pt): Pt => [L + u * W, T + v * H];
  const flat = (pts: Pt[]) => pts.flatMap(([x, y]) => [r1(x), r1(y), P]);
  const closedPolygon = (unit: Pt[]) => {
    const out: Pt[] = [];
    for (const p of [...unit, unit[0]]) out.push(at(p), at(p));
    return flat(out);
  };

  if (kind === 'line') return [flat([[x0, y0], [ex, ey]])];
  if (kind === 'arrow') return [arrowLine(x0, y0, ex, ey)];

  const poly = POLYGONS[kind];
  if (poly) return [closedPolygon(poly)];
  if (kind === 'arrowLeft' || kind === 'arrowUp' || kind === 'arrowDown') {
    const turn: Record<string, (p: Pt) => Pt> = {
      arrowLeft: ([u, v]) => [1 - u, v],
      arrowUp: ([u, v]) => [v, 1 - u],
      arrowDown: ([u, v]) => [v, u],
    };
    return [closedPolygon(POLYGONS.arrowRight!.map(turn[kind]))];
  }

  const curve = CURVES[kind];
  if (curve) {
    const n = 2 * Math.max(16, Math.min(72, Math.round((W + H) / 8)));
    const pts: Pt[] = [];
    for (let i = 0; i <= n + 1; i++) {
      const p = at(curve((i % n) / n));
      pts.push(p);
      // The heart's dip at the top (t = 0) and tip at the bottom (t = 1/2) stay sharp.
      if (kind === 'heart' && (i === 0 || i === n / 2 || i === n)) pts.push(p);
    }
    return [flat(pts)];
  }

  if (kind === 'star') {
    const pts: Pt[] = [];
    for (let i = 0; i <= 10; i++) {
      const r = i % 2 ? 0.2 : 0.5;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const p = at([0.5 + r * Math.cos(a), 0.53 + r * Math.sin(a) * 0.98]);
      pts.push(p, p);
    }
    return [flat(pts)];
  }

  if (kind === 'capsule') {
    // A box with fully rounded ends (radius = half the shorter side).
    const r = Math.min(W, H) / 2;
    // Start and end mid-way along the top edge, so the outline closes on a straight line.
    const pts: Pt[] = [[L + W / 2, T]];
    const arc = (cx: number, cy: number, from: number) => {
      for (let i = 0; i <= 12; i++) {
        const a = from + (i / 12) * (Math.PI / 2);
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    };
    arc(L + W - r, T + r, -Math.PI / 2);
    arc(L + W - r, T + H - r, 0);
    arc(L + r, T + H - r, Math.PI / 2);
    arc(L + r, T + r, Math.PI);
    pts.push([L + W / 2, T]);
    return [flat(pts)];
  }

  if (kind === 'crossbox' || kind === 'checkbox') {
    const box = closedPolygon(POLYGONS.rectangle!);
    if (kind === 'crossbox') return [box, flat([at([0, 0]), at([1, 1])]), flat([at([1, 0]), at([0, 1])])];
    const tick: Pt[] = [at([0.22, 0.55]), at([0.42, 0.75]), at([0.42, 0.75]), at([0.8, 0.25])];
    return [box, flat(tick)];
  }
  return [];
}

/** A line with an arrowhead at its end (one stroke that retraces the head). */
function arrowLine(x0: number, y0: number, ex: number, ey: number): number[] {
  const dx = ex - x0, dy = ey - y0;
  const len = Math.hypot(dx, dy) || 1;
  const head = Math.min(28, Math.max(10, len * 0.25));
  const ux = dx / len, uy = dy / len;
  const a = (28 * Math.PI) / 180;
  const bx = (s: number) => ex - head * (ux * Math.cos(a) - s * uy * Math.sin(a));
  const by = (s: number) => ey - head * (uy * Math.cos(a) + s * ux * Math.sin(a));
  const pts: Pt[] = [[x0, y0], [ex, ey], [ex, ey], [bx(1), by(1)], [bx(1), by(1)], [ex, ey], [ex, ey], [bx(-1), by(-1)]];
  return pts.flatMap(([x, y]) => [r1(x), r1(y), P]);
}

/** Lines snap to the nearest 45° when within SNAP_DEG, or always when `force` is on. */
function snapAngle(dx: number, dy: number, force: boolean) {
  const len = Math.hypot(dx, dy);
  if (!len) return { dx, dy };
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (force || Math.abs(snapped - ang) < (SNAP_DEG * Math.PI) / 180) return { dx: Math.cos(snapped) * len, dy: Math.sin(snapped) * len };
  return { dx, dy };
}

/** 24×24 outline icons for the palette, in the app's icon style. */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const SHAPE_ICONS: Record<ShapeKind, string> = {
  rectangle: svg('<rect x="4" y="4" width="16" height="16" rx="1"/>'),
  ellipse: svg('<circle cx="12" cy="12" r="8.5"/>'),
  triangle: svg('<path d="M12 4.5 20.5 19h-17Z"/>'),
  diamond: svg('<path d="M12 3.5 20.5 12 12 20.5 3.5 12Z"/>'),
  hexagon: svg('<path d="M8 4h8l4.5 8-4.5 8H8l-4.5-8Z"/>'),
  capsule: svg('<rect x="7" y="3.5" width="10" height="17" rx="5"/>'),
  parallelogram: svg('<path d="M8 4.5h12.5L16 19.5H3.5Z"/>'),
  star: svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>'),
  cloud: svg('<path d="M7 18.5a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6-1.3A4.7 4.7 0 0 1 17.5 18.5Z"/>'),
  heart: svg('<path d="M12 20s-8-4.9-8-10.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.6C20 15.1 12 20 12 20Z"/>'),
  crossbox: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="m4 4 16 16M20 4 4 20"/>'),
  checkbox: svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="m8 12.5 3 3 5.5-7"/>'),
  arrowLeft: svg('<path d="M3.5 12 11 5v4h9.5v6H11v4Z"/>'),
  arrowUp: svg('<path d="M12 3.5 19 11h-4v9.5H9V11H5Z"/>'),
  arrowDown: svg('<path d="M12 20.5 5 13h4V3.5h6V13h4Z"/>'),
  arrowRight: svg('<path d="M20.5 12 13 19v-4H3.5V9H13V5Z"/>'),
  line: svg('<path d="M5 19 19 5"/>'),
  arrow: svg('<path d="M5 19 19 5"/><path d="M11 5h8v8"/>'),
};
