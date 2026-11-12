import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * End-to-end tests for the strip lock and palm rejection.
 * Touches are sent through the Chrome DevTools Protocol so we can control contact size
 * (radiusX / radiusY), which the browser reports to the page as PointerEvent width / height.
 */

const STRIP = 90; // default strip height in page units (page width = 1000)
const PEN = 3; // contact radius in CSS px for a stylus tip
const PALM = 40; // contact radius in CSS px for a palm

interface Geo {
  areaX: number;
  areaY: number;
  marginX: number;
  stripPx: number;
}

async function setup(page: Page): Promise<{ cdp: CDPSession; geo: Geo }> {
  await page.goto('/');
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

const stripY = (g: Geo, i: number) => g.areaY + i * g.stripPx + g.stripPx / 2;

type TouchPoint = { x: number; y: number; radiusX: number; radiusY: number; id: number };
const tp = (x: number, y: number, r: number, id: number): TouchPoint => ({ x, y, radiusX: r, radiusY: r, id });

async function send(cdp: CDPSession, type: string, touchPoints: TouchPoint[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

/** Drag one contact from (x0,y0) to (x1,y1). `held` contacts stay down the whole time (e.g. a resting palm). */
async function drag(cdp: CDPSession, x0: number, y0: number, x1: number, y1: number, r = PEN, held: TouchPoint[] = []) {
  await send(cdp, 'touchStart', [tp(x0, y0, r, 1), ...held]);
  for (let i = 1; i <= 10; i++) {
    await send(cdp, 'touchMove', [tp(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, r, 1), ...held]);
  }
  await send(cdp, 'touchEnd', held);
}

async function tapMargin(cdp: CDPSession, g: Geo, strip: number) {
  await send(cdp, 'touchStart', [tp(g.marginX, stripY(g, strip), PEN, 7)]);
  await send(cdp, 'touchEnd', []);
}

/** Number of strokes saved in local mode. */
async function savedStrokes(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const k of Object.keys(localStorage)) if (k.startsWith('lb-local-strokes-')) n += JSON.parse(localStorage[k]).length;
    return n;
  });
}

const expectStrokes = (page: Page, n: number) => expect.poll(() => savedStrokes(page)).toBe(n);

test('stylus draws in the unlocked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 400, stripY(geo, 0));
  await expectStrokes(page, 1);
});

test('touches in locked strips are ignored', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 3), geo.areaX + 400, stripY(geo, 3));
  await drag(cdp, geo.areaX + 100, stripY(geo, 5), geo.areaX + 300, stripY(geo, 5), PALM);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('palm-sized contacts in the unlocked strip are ignored', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 400, stripY(geo, 0), PALM);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('a contact that grows into a palm mid-stroke is cancelled', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 100, y, PEN, 1)]);
  await send(cdp, 'touchMove', [tp(geo.areaX + 120, y, PEN, 1)]);
  await send(cdp, 'touchMove', [tp(geo.areaX + 140, y, PALM, 1)]);
  await send(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('stylus keeps drawing while a palm rests on a locked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const palm = tp(geo.areaX + 500, stripY(geo, 3), PALM, 9);
  await send(cdp, 'touchStart', [palm]);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 600, stripY(geo, 0), PEN, [palm]);
  await send(cdp, 'touchEnd', []);
  await expectStrokes(page, 1);
});

test('tapping the margin moves the unlocked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await tapMargin(cdp, geo, 2);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0)); // strip 0 is now locked
  await drag(cdp, geo.areaX + 100, stripY(geo, 2), geo.areaX + 300, stripY(geo, 2));
  await expectStrokes(page, 1);
  await expect(page.locator('.strip-btn.on')).toHaveCount(1);
});

test('multi-strip mode allows strokes across strips and locks all when turned off', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.getByRole('switch').click();
  await tapMargin(cdp, geo, 4);
  await tapMargin(cdp, geo, 5);
  await expect(page.locator('.strip-btn.on')).toHaveCount(3); // strip 0 plus 4 and 5
  await drag(cdp, geo.areaX + 200, stripY(geo, 4) - 20, geo.areaX + 260, stripY(geo, 5) + 20);
  await expectStrokes(page, 1);

  await page.getByRole('switch').click();
  await expect(page.locator('.strip-btn.on')).toHaveCount(0);
  await drag(cdp, geo.areaX + 100, stripY(geo, 4), geo.areaX + 300, stripY(geo, 4));
  await page.waitForTimeout(200);
  await expectStrokes(page, 1);
});

test('undo, redo and eraser', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const y = stripY(geo, 0);
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  await drag(cdp, geo.areaX + 400, y, geo.areaX + 600, y);
  await expectStrokes(page, 2);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectStrokes(page, 1);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expectStrokes(page, 2);
  await page.getByRole('button', { name: 'Eraser' }).click();
  await drag(cdp, geo.areaX + 200, y - 30, geo.areaX + 200, y + 30);
  await expectStrokes(page, 1);
});

test('notes persist across reloads', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expectStrokes(page, 1);
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  await expectStrokes(page, 1);
  await expect(page.locator('.title-input')).not.toHaveValue('');
});

test('works under the production Content-Security-Policy', async ({ page }) => {
  // Apply the same CSP the Docker image sends, so a CSP-breaking change fails CI.
  const conf = readFileSync('docker/security-headers.conf', 'utf8');
  const csp = /Content-Security-Policy "([^"]+)"/.exec(conf)![1];
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expectStrokes(page, 1);
  expect(violations).toEqual([]);
});
