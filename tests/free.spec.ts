import { expect, test, type Page } from '@playwright/test';
import { PALM, PEN, attachBoard, drag, expectStrokes, send, setup, stripY, tp } from './helpers';

/** Free whiteboard mode: no strips or locks, whole page takes ink, two fingers scroll. */

const freeSwitch = (page: Page) => page.getByRole('switch', { name: 'Free whiteboard' });

/** Y (page units) of the first point of the newest stroke. */
const lastStrokeY = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    return list[list.length - 1].points[1] as number;
  });

/** Horizontal span (page units) of the newest stroke. */
const lastStrokeSpan = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    const xs = (list[list.length - 1].points as number[]).filter((_, i) => i % 3 === 0);
    return Math.max(...xs) - Math.min(...xs);
  });

/** Switch free mode and return fresh board geometry (the margin hides/shows, so the page moves). */
async function toggleFree(page: Page) {
  await freeSwitch(page).click();
  await page.waitForTimeout(150);
  return attachBoard(page);
}

test('free mode hides strips and margin, takes ink anywhere, and still ignores palms', async ({ page }) => {
  await setup(page);
  const { cdp, geo } = await toggleFree(page);
  await expect(page.locator('.margin')).toBeHidden();
  await expect(page.locator('.strip-controls')).toBeHidden();
  await drag(cdp, geo.areaX + 100, stripY(geo, 4), geo.areaX + 400, stripY(geo, 5)); // used to be locked
  await expectStrokes(page, 1);
  await drag(cdp, geo.areaX + 100, stripY(geo, 3), geo.areaX + 400, stripY(geo, 3), PALM);
  await page.waitForTimeout(200);
  await expectStrokes(page, 1);
});

test('pinch zooms in, and going back to strips resets the zoom', async ({ page }) => {
  await setup(page);
  const { cdp, geo } = await toggleFree(page);
  const y = stripY(geo, 2);
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  const normal = await lastStrokeSpan(page);

  // Two fingers land together and spread apart: zoom in.
  const cx = geo.areaX + 350, cy = stripY(geo, 5);
  await send(cdp, 'touchStart', [tp(cx - 40, cy, PEN, 1), tp(cx + 40, cy, PEN, 2)]);
  for (let i = 1; i <= 10; i++) await send(cdp, 'touchMove', [tp(cx - 40 - i * 8, cy, PEN, 1), tp(cx + 40 + i * 8, cy, PEN, 2)]);
  await send(cdp, 'touchEnd', []);
  await page.waitForTimeout(150);
  await expectStrokes(page, 1); // the pinch drew nothing

  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  expect(await lastStrokeSpan(page)).toBeLessThan(normal * 0.6); // same finger movement, smaller on the page

  // Strips and back: normal size again.
  await toggleFree(page);
  const again = await toggleFree(page);
  await drag(again.cdp, again.geo.areaX + 100, stripY(again.geo, 2), again.geo.areaX + 300, stripY(again.geo, 2));
  expect(Math.abs((await lastStrokeSpan(page)) - normal)).toBeLessThan(normal * 0.15);
});

test('a resting palm plus a pen draws instead of scrolling', async ({ page }) => {
  await setup(page);
  const { cdp, geo } = await toggleFree(page);
  const y = stripY(geo, 2);
  const palm = tp(geo.areaX + 500, stripY(geo, 6), PALM, 9);
  await send(cdp, 'touchStart', [palm]);
  await page.waitForTimeout(400);
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 400, y, PEN, [palm]);
  await send(cdp, 'touchEnd', []);
  await expectStrokes(page, 1); // only the pen drew
  const scale = geo.stripPx / 90;
  expect(Math.abs((await lastStrokeY(page)) - (y - geo.areaY) / scale)).toBeLessThan(2); // nothing scrolled
});

test('turning free mode off brings the locks back, and the choice survives a reload', async ({ page }) => {
  await setup(page);
  await toggleFree(page);
  await page.reload();
  await attachBoard(page);
  await expect(freeSwitch(page)).toHaveAttribute('aria-checked', 'true');

  const { cdp, geo } = await toggleFree(page);
  await expect(page.locator('.strip-btn').first()).toBeVisible();
  await drag(cdp, geo.areaX + 100, stripY(geo, 5), geo.areaX + 400, stripY(geo, 5)); // locked strip
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});
