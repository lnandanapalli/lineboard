import { createElement, type SVGAttributes } from 'react';

const cache = new Map<string, { attrs: Record<string, string>; body: string }>();

/** React's name for an SVG attribute (stroke-width -> strokeWidth; aria-* and data-* stay). */
const propName = (a: string) => (a.startsWith('aria-') || a.startsWith('data-') ? a : a === 'class' ? 'className' : a.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));

/**
 * One of the app's icons (icons.ts holds them as SVG markup), drawn as a real <svg> element, so the
 * page is the same as when the markup was inserted directly (CSS such as `> svg` keeps working).
 */
export function Svg({ icon, ...rest }: { icon: string } & SVGAttributes<SVGSVGElement>) {
  let parsed = cache.get(icon);
  if (!parsed) {
    const m = /^\s*<svg([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(icon);
    const attrs: Record<string, string> = {};
    for (const [, k, v] of (m?.[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[propName(k)] = v;
    parsed = { attrs, body: m?.[2] ?? '' };
    cache.set(icon, parsed);
  }
  return createElement('svg', { ...parsed.attrs, ...rest, dangerouslySetInnerHTML: { __html: parsed.body } });
}
