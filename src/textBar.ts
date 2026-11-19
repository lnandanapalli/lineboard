import { PEN_COLORS } from './colors';
import { FAMILY_CSS, FAMILY_NAMES, FONT_FAMILIES, type TextAlign, type TextStyle } from './textStyle';

/** What the format bar shows and changes: the text box being typed, or the selected text boxes. */
export interface TextFormat {
  style: TextStyle;
  size: number;
  color: string;
}
export type TextFormatPatch = Partial<TextStyle> & { size?: number; color?: string };

/** Text sizes the − / + buttons step through (page units; the page is 1000 wide). */
export const TEXT_SIZES = [12, 16, 20, 24, 28, 36, 44, 56, 72, 96];
export const stepSize = (size: number, dir: 1 | -1) =>
  dir > 0 ? (TEXT_SIZES.find((s) => s > size + 0.01) ?? TEXT_SIZES.at(-1)!) : ([...TEXT_SIZES].reverse().find((s) => s < size - 0.01) ?? TEXT_SIZES[0]);

const svg = (body: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
const ALIGN_ICONS: Record<TextAlign, string> = {
  left: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  center: svg('<path d="M4 6h16M7 12h10M5.5 18h13"/>'),
  right: svg('<path d="M4 6h16M10 12h10M7 18h13"/>'),
};
const ALIGN_NAMES: Record<TextAlign, string> = { left: 'Align left', center: 'Align centre', right: 'Align right' };

/**
 * A floating bar of text formatting controls: font, size, bold / italic / underline, alignment and
 * colour. Pressing it never takes focus from the text being typed.
 */
export function createTextBar(onChange: (patch: TextFormatPatch) => void) {
  const el = document.createElement('div');
  el.className = 'text-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Text format');
  // Keep the caret in the text box, and keep presses away from the board underneath.
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  let state: TextFormat = { style: {}, size: 28, color: PEN_COLORS[0] };

  const button = (label: string, html: string, fn: () => void, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn ' + cls;
    b.innerHTML = html;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', fn);
    return b;
  };
  const group = (label: string, ...kids: HTMLElement[]) => {
    const g = document.createElement('div');
    g.className = 'tb-group';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    g.append(...kids);
    return g;
  };

  const families = FONT_FAMILIES.map((f) => {
    const b = button(FAMILY_NAMES[f], 'Aa', () => onChange({ family: f }), 'tb-font');
    b.style.fontFamily = FAMILY_CSS[f];
    b.setAttribute('role', 'radio');
    return b;
  });
  const sizeOut = document.createElement('output');
  sizeOut.className = 'tb-size';
  const smaller = button('Smaller text', svg('<path d="M6 12h12"/>'), () => onChange({ size: stepSize(state.size, -1) }));
  const larger = button('Larger text', svg('<path d="M6 12h12M12 6v12"/>'), () => onChange({ size: stepSize(state.size, 1) }));
  const bold = button('Bold', '<b>B</b>', () => onChange({ bold: !state.style.bold }), 'tb-toggle');
  const italic = button('Italic', '<i>I</i>', () => onChange({ italic: !state.style.italic }), 'tb-toggle');
  const underline = button('Underline', '<u>U</u>', () => onChange({ underline: !state.style.underline }), 'tb-toggle');
  const aligns = (['left', 'center', 'right'] as const).map((a) => {
    const b = button(ALIGN_NAMES[a], ALIGN_ICONS[a], () => onChange({ align: a }));
    b.setAttribute('role', 'radio');
    return b;
  });
  const swatches = PEN_COLORS.map((c) => {
    const b = button('Text colour ' + c, '', () => onChange({ color: c }), 'tb-swatch');
    b.style.setProperty('--c', c);
    b.setAttribute('role', 'radio');
    return b;
  });

  el.append(
    group('Font', ...families),
    group('Size', smaller, sizeOut, larger),
    group('Emphasis', bold, italic, underline),
    group('Alignment', ...aligns),
    group('Colour', ...swatches),
  );

  function update(next: TextFormat) {
    state = next;
    const s = next.style;
    families.forEach((b, i) => b.setAttribute('aria-checked', String((s.family ?? 'sans') === FONT_FAMILIES[i])));
    sizeOut.textContent = String(Math.round(next.size));
    smaller.disabled = next.size <= TEXT_SIZES[0];
    larger.disabled = next.size >= TEXT_SIZES.at(-1)!;
    bold.setAttribute('aria-pressed', String(!!s.bold));
    italic.setAttribute('aria-pressed', String(!!s.italic));
    underline.setAttribute('aria-pressed', String(!!s.underline));
    aligns.forEach((b, i) => b.setAttribute('aria-checked', String((s.align ?? 'left') === (['left', 'center', 'right'] as const)[i])));
    swatches.forEach((b, i) => b.setAttribute('aria-checked', String(PEN_COLORS[i].toLowerCase() === next.color.toLowerCase())));
  }
  return { el, update };
}
