import { lsGet, lsSet } from './util';

/**
 * Light and dark mode. The choice (System, Light or Dark) is kept on this device, like the
 * orientation lock: a phone in dark mode and a desk screen in light mode can each have their own.
 * "System" follows the device's setting and changes with it.
 *
 * In dark mode the page is dark too. Ink is shown with its lightness turned around (black ink
 * shows near-white, a dark blue a lighter blue; hues stay), only on screen: notes, files, pictures
 * and PDFs keep the colours they were drawn in.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEMES: ThemeChoice[] = ['system', 'light', 'dark'];
const KEY = 'lb-theme';

const media = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

export function themeChoice(): ThemeChoice {
  const v = lsGet<string>(KEY, 'system');
  return THEMES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'system';
}

export function isDark(choice = themeChoice()): boolean {
  return choice === 'dark' || (choice === 'system' && !!media()?.matches);
}

const listeners = new Set<(dark: boolean) => void>();
let watching = false;

/** Apply the theme to the page (and follow the device's setting while it is "System"). */
export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#16191e' : '#ffffff');
  for (const fn of listeners) fn(dark);
  if (!watching) {
    watching = true;
    media()?.addEventListener?.('change', () => {
      if (themeChoice() === 'system' && document.documentElement.dataset.theme) applyTheme();
    });
  }
}

export function setTheme(choice: ThemeChoice) {
  lsSet(KEY, choice);
  applyTheme();
}

/** Back to the light look (leaving the app for the public pages, which have their own colours). */
export function clearTheme() {
  delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
}

export function onThemeChange(fn: (dark: boolean) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * An ink colour as shown on the dark page: same hue and saturation, lightness turned around and
 * kept readable (black → near-white, white → mid grey, mid tones a little lighter).
 */
export function darkInk(color: string): string {
  const m = /^#(?:([0-9a-f]{6})([0-9a-f]{2})?|([0-9a-f]{3})([0-9a-f])?)$/i.exec(color);
  if (!m) return color;
  const hex = m[1] ?? [...m[3]].map((x) => x + x).join('');
  const alpha = m[2] ?? (m[4] ? m[4] + m[4] : '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let hue = 0;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const l2 = 0.4 + 0.55 * (1 - l);
  // Back to RGB (HSL → RGB).
  const c = (1 - Math.abs(2 * l2 - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const mm = l2 - c / 2;
  const [r2, g2, b2] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v + mm)) * 255).toString(16).padStart(2, '0');
  return `#${to(r2)}${to(g2)}${to(b2)}${alpha}`;
}
