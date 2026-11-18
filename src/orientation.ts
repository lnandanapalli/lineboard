import { lsGet, lsSet } from './util';

/**
 * Manual orientation. Browsers rotate pages with the device, and a page can't lock that
 * (except in full-screen Android apps). So when manual orientation is on, the app element itself
 * is rotated with CSS:
 *
 *   on-screen rotation = (chosen rotation - device's current screen angle) mod 360
 *
 * which keeps the app fixed to the body of the tablet however the system rotates the screen, and
 * lets the rotate button turn it a quarter turn at a time. Everything that reads pointer
 * coordinates converts them with `clientToApp`, and popups are placed with `appRect`.
 *
 * This is a per-device preference (how you hold this tablet), so it is kept in localStorage,
 * not synced with the account settings.
 */

export type Rotation = 0 | 90 | 180 | 270;
interface Stored {
  manual: boolean;
  /** Chosen rotation, relative to the device's natural orientation. */
  rotation: Rotation;
}
const KEY = 'lb-orientation';

let state: Stored = { manual: false, rotation: 0, ...lsGet<Partial<Stored>>(KEY, {}) };
/** The rotation currently applied to the app element (0 when manual orientation is off). */
let applied: Rotation = 0;
let appEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The angle the system has rotated the screen to (0, 90, 180, 270), or 0 when unknown. */
function screenAngle(): number {
  const a = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.angle : (window as { orientation?: number }).orientation ?? 0;
  return (((Math.round(Number(a) / 90) * 90) % 360) + 360) % 360;
}

const norm = (n: number) => ((((n % 360) + 360) % 360) as Rotation);

export const orientation = {
  get manual() {
    return state.manual;
  },
  get applied() {
    return applied;
  },
  setManual(on: boolean) {
    // Start from how things look now, so turning it on never makes the app jump.
    state = { manual: on, rotation: on ? norm(screenAngle()) : 0 };
    save();
  },
  /** Turn the app a quarter turn clockwise. */
  rotateRight() {
    if (!state.manual) return;
    state = { ...state, rotation: norm(state.rotation + 90) };
    save();
  },
  onChange(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function save() {
  lsSet(KEY, state);
  apply();
}

/** Attach to the app root (called when the notebook screen is built). */
export function attachOrientation(el: HTMLElement) {
  appEl = el;
  apply();
}

export function detachOrientation(el: HTMLElement) {
  if (appEl === el) appEl = null;
  applied = 0;
  document.documentElement.removeAttribute('data-rotation');
}

function apply() {
  applied = state.manual ? norm(state.rotation - screenAngle()) : 0;
  const el = appEl;
  if (el) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (applied === 0) {
      el.style.removeProperty('transform');
      el.style.removeProperty('width');
      el.style.removeProperty('height');
      el.classList.remove('rotated');
    } else {
      const side = applied === 90 || applied === 270;
      el.classList.add('rotated');
      el.style.width = `${side ? H : W}px`;
      el.style.height = `${side ? W : H}px`;
      el.style.transform = {
        90: `translate(${W}px, 0) rotate(90deg)`,
        180: `translate(${W}px, ${H}px) rotate(180deg)`,
        270: `translate(0, ${H}px) rotate(270deg)`,
      }[applied];
    }
  }
  // Dialogs live in the browser's top layer, outside the app element; CSS rotates them from this.
  if (applied) document.documentElement.setAttribute('data-rotation', String(applied));
  else document.documentElement.removeAttribute('data-rotation');
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => apply());
  screen.orientation?.addEventListener?.('change', () => apply());
}

/** Screen (client) coordinates to the app's own, upright coordinates. */
export function clientToApp(x: number, y: number): { x: number; y: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  switch (applied) {
    case 90:
      return { x: y, y: W - x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      return { x: H - y, y: x };
    default:
      return { x, y };
  }
}

/** An element's box in app coordinates (exact, since rotations are quarter turns). */
export function appRect(el: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  const a = clientToApp(r.left, r.top);
  const b = clientToApp(r.right, r.bottom);
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Wheel / drag deltas from screen axes to app axes. */
export function deltaToApp(dx: number, dy: number): { dx: number; dy: number } {
  switch (applied) {
    case 90:
      return { dx: dy, dy: -dx };
    case 180:
      return { dx: -dx, dy: -dy };
    case 270:
      return { dx: -dy, dy: dx };
    default:
      return { dx, dy };
  }
}

/** Width/height of the app (swapped when it is turned sideways). */
export function appViewport() {
  const side = applied === 90 || applied === 270;
  return { width: side ? window.innerHeight : window.innerWidth, height: side ? window.innerWidth : window.innerHeight };
}
