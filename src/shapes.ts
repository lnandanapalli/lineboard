/**
 * Shapes are saved as ordinary pen strokes whose points trace the outline, so undo, the eraser,
 * sync and encryption treat them like any other ink. Strokes are drawn as smooth curves through
 * their points; a doubled point makes the curve pass exactly through it, which keeps corners sharp.
 */

export type ShapeKind = 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle';
export const SHAPES: ShapeKind[] = ['line', 'arrow', 'rectangle', 'ellipse', 'triangle'];

const P = 0.5; // constant pressure: shapes have an even width
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Flat [x, y, p, ...] points for a shape dragged from (x0, y0) to (x1, y1). */
export function shapePoints(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, constrain: boolean): number[] {
  let dx = x1 - x0;
  let dy = y1 - y0;
  if (kind === 'line' || kind === 'arrow') {
    ({ dx, dy } = snapAngle(dx, dy, constrain));
  } else if (constrain) {
    // Square / circle / equal-sided triangle: use the larger side for both.
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  const ex = x0 + dx;
  const ey = y0 + dy;
  const out: number[] = [];
  const add = (x: number, y: number) => out.push(r1(x), r1(y), P);
  const corner = (x: number, y: number) => {
    add(x, y);
    add(x, y);
  };

  switch (kind) {
    case 'line':
      add(x0, y0);
      add(ex, ey);
      break;
    case 'arrow': {
      const len = Math.hypot(dx, dy) || 1;
      const head = Math.min(28, Math.max(10, len * 0.25));
      const ux = dx / len;
      const uy = dy / len;
      // Two barbs at ±28° from the shaft.
      const a = (28 * Math.PI) / 180;
      const bx = (s: number) => ex - head * (ux * Math.cos(a) - s * uy * Math.sin(a));
      const by = (s: number) => ey - head * (uy * Math.cos(a) + s * ux * Math.sin(a));
      add(x0, y0);
      corner(ex, ey);
      corner(bx(1), by(1));
      corner(ex, ey);
      add(bx(-1), by(-1));
      break;
    }
    case 'rectangle':
      corner(x0, y0);
      corner(ex, y0);
      corner(ex, ey);
      corner(x0, ey);
      corner(x0, y0);
      break;
    case 'triangle':
      corner((x0 + ex) / 2, y0);
      corner(ex, ey);
      corner(x0, ey);
      corner((x0 + ex) / 2, y0);
      break;
    case 'ellipse': {
      const cx = (x0 + ex) / 2;
      const cy = (y0 + ey) / 2;
      const rx = Math.abs(dx) / 2;
      const ry = Math.abs(dy) / 2;
      const n = Math.max(24, Math.min(96, Math.round((rx + ry) / 3)));
      for (let i = 0; i <= n + 1; i++) {
        const t = (i / n) * Math.PI * 2;
        add(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      }
      break;
    }
  }
  return out;
}

/** Lines snap to the nearest 45° when Shift is held, and to 0/90° when within 4° anyway. */
function snapAngle(dx: number, dy: number, constrain: boolean) {
  const len = Math.hypot(dx, dy);
  if (!len) return { dx, dy };
  const ang = Math.atan2(dy, dx);
  const step = constrain ? Math.PI / 4 : Math.PI / 2;
  const snapped = Math.round(ang / step) * step;
  if (constrain || Math.abs(snapped - ang) < (4 * Math.PI) / 180) return { dx: Math.cos(snapped) * len, dy: Math.sin(snapped) * len };
  return { dx, dy };
}
