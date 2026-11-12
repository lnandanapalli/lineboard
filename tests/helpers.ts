import { expect, type CDPSession, type Page } from '@playwright/test';

/** Shared helpers: touches are sent through the Chrome DevTools Protocol so tests control contact size. */

export const STRIP = 90; // default strip height in page units (page width = 1000)
export const PEN = 3; // contact radius in CSS px for a stylus tip
export const PALM = 40; // contact radius in CSS px for a palm

export interface Geo {
  areaX: number;
  areaY: number;
  marginX: number;
  stripPx: number;
}

export async function setup(page: Page): Promise<{ cdp: CDPSession; geo: Geo }> {
  await page.goto('/');
  return attachBoard(page);
}

/** Wait for the board on the current page and return touch helpers for it. */
export async function attachBoard(page: Page): Promise<{ cdp: CDPSession; geo: Geo }> {
  await page.locator('.canvas-area canvas.live').waitFor();
  const hint = page.locator('.hint .link');
  if (await hint.isVisible()) await hint.click();
  const cdp = await page.context().newCDPSession(page);
  const geo = await page.evaluate((strip) => {
    const a = document.querySelector('.canvas-area')!.getBoundingClientRect();
    const m = document.querySelector('.margin')!.getBoundingClientRect();
    return { areaX: a.left, areaY: a.top, marginX: m.left + m.width / 2, stripPx: (strip * a.width) / 1000 };
  }, STRIP);
  return { cdp, geo };
}

export const stripY = (g: Geo, i: number) => g.areaY + i * g.stripPx + g.stripPx / 2;

export type TouchPoint = { x: number; y: number; radiusX: number; radiusY: number; id: number };
export const tp = (x: number, y: number, r: number, id: number): TouchPoint => ({ x, y, radiusX: r, radiusY: r, id });

export async function send(cdp: CDPSession, type: string, touchPoints: TouchPoint[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

/** Drag one contact from (x0,y0) to (x1,y1). `held` contacts stay down the whole time (e.g. a resting palm). */
export async function drag(cdp: CDPSession, x0: number, y0: number, x1: number, y1: number, r = PEN, held: TouchPoint[] = []) {
  await send(cdp, 'touchStart', [tp(x0, y0, r, 1), ...held]);
  for (let i = 1; i <= 10; i++) {
    await send(cdp, 'touchMove', [tp(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, r, 1), ...held]);
  }
  await send(cdp, 'touchEnd', held);
}

export async function tapMargin(cdp: CDPSession, g: Geo, strip: number) {
  await send(cdp, 'touchStart', [tp(g.marginX, stripY(g, strip), PEN, 7)]);
  await send(cdp, 'touchEnd', []);
}

/** Number of strokes saved in local mode. */
export async function savedStrokes(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const k of Object.keys(localStorage)) if (k.startsWith('lb-local-strokes-')) n += JSON.parse(localStorage[k]).length;
    return n;
  });
}

export const expectStrokes = (page: Page, n: number) => expect.poll(() => savedStrokes(page)).toBe(n);
