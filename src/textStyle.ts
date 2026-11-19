/**
 * How a text box is set: font family, bold / italic / underline and alignment. Only what differs
 * from the plain default (sans, regular, left) is stored, so older text boxes need nothing.
 */
import '@fontsource/caveat/400.css';
import '@fontsource/caveat/700.css';

export const FONT_FAMILIES = ['sans', 'serif', 'mono', 'hand'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export interface TextStyle {
  family?: FontFamily;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: TextAlign;
}

export const FAMILY_NAMES: Record<FontFamily, string> = { sans: 'Sans', serif: 'Serif', mono: 'Mono', hand: 'Handwriting' };

/** CSS font stacks. The handwriting face is bundled with the app (works offline and under the CSP). */
export const FAMILY_CSS: Record<FontFamily, string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  hand: "Caveat, 'Segoe Print', 'Comic Sans MS', cursive",
};

/** The canvas / CSS `font` shorthand for a style at a size (px). */
export function fontCss(style: TextStyle | undefined, size: number): string {
  const s = style ?? {};
  return `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${size}px ${FAMILY_CSS[s.family ?? 'sans']}`;
}

/** Keep only valid, non-default fields (also used to clean data read from storage). */
export function cleanStyle(raw: unknown): TextStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: TextStyle = {};
  if (FONT_FAMILIES.includes(r.family as FontFamily) && r.family !== 'sans') out.family = r.family as FontFamily;
  if (r.bold === true) out.bold = true;
  if (r.italic === true) out.italic = true;
  if (r.underline === true) out.underline = true;
  if (TEXT_ALIGNS.includes(r.align as TextAlign) && r.align !== 'left') out.align = r.align as TextAlign;
  return out;
}

export const isPlain = (s: TextStyle | undefined) => !s || Object.keys(cleanStyle(s)).length === 0;
