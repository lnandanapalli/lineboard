import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { PEN, attachBoard, drag, expectStrokes, send, setup, tp, type Geo } from './helpers';

/** Split mode: two screen panes, each lockable; the page scrolls under them; the divider moves only when armed. */

async function chooseSplit(page: Page) {
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Split/ }).click();
  await page.waitForTimeout(150);
  return attachBoard(page);
}

const board = async (page: Page) => (await page.locator('.canvas-area').boundingBox())!;
const marginTap = async (cdp: CDPSession, geo: Geo, y: number) => {
  await send(cdp, 'touchStart', [tp(geo.marginX, y, PEN, 7)]);
  await send(cdp, 'touchEnd', []);
};
async function marginDrag(cdp: CDPSession, geo: Geo, y0: number, y1: number) {
  await send(cdp, 'touchStart', [tp(geo.marginX, y0, PEN, 8)]);
  for (let i = 1; i <= 10; i++) await send(cdp, 'touchMove', [tp(geo.marginX, y0 + ((y1 - y0) * i) / 10, PEN, 8)]);
  await send(cdp, 'touchEnd', []);
}
const firstY = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    return list[list.length - 1].points[1] as number;
  });

test('panes lock and unlock independently', async ({ page }) => {
  await setup(page);
  const { cdp, geo } = await chooseSplit(page);
  const b = await board(page);
  const topY = b.y + b.height * 0.25;
  const bottomY = b.y + b.height * 0.75;
  await expect(page.locator('.split-pane')).toHaveCount(2);
  await expect(page.getByLabel('Lock top pane')).toBeAttached(); // top starts unlocked
  await expect(page.getByLabel('Unlock bottom pane')).toBeAttached(); // bottom starts locked (rest your palm there)

  await drag(cdp, geo.areaX + 100, topY, geo.areaX + 300, topY);
  await expectStrokes(page, 1);
  await drag(cdp, geo.areaX + 100, bottomY, geo.areaX + 300, bottomY);
  await page.waitForTimeout(200);
  await expectStrokes(page, 1); // locked pane

  await marginTap(cdp, geo, bottomY);
  await expect(page.getByLabel('Lock bottom pane')).toBeAttached();
  await drag(cdp, geo.areaX + 100, bottomY, geo.areaX + 300, bottomY);
  await expectStrokes(page, 2);

  await marginTap(cdp, geo, topY);
  await drag(cdp, geo.areaX + 100, topY + 20, geo.areaX + 300, topY + 20);
  await page.waitForTimeout(200);
  await expectStrokes(page, 2); // top now locked
});

test('margin drags scroll the page under the panes; the divider moves only after tapping its grip', async ({ page }) => {
  await setup(page);
  const { cdp, geo } = await chooseSplit(page);
  const b = await board(page);
  const mid = b.y + b.height / 2;
  const topY = b.y + b.height * 0.25;
  const grip = page.locator('.split-grip');
  const gripTop = async () => (await grip.boundingBox())!.y;
  const g0 = await gripTop();

  // A plain drag scrolls, even when it starts on the divider.
  await drag(cdp, geo.areaX + 100, topY, geo.areaX + 300, topY);
  const before = await firstY(page);
  await marginDrag(cdp, geo, mid, mid - 200);
  expect(Math.abs((await gripTop()) - g0)).toBeLessThan(1);
  await drag(cdp, geo.areaX + 100, topY, geo.areaX + 300, topY);
  await expectStrokes(page, 2);
  expect(await firstY(page)).toBeGreaterThan(before + 50); // same screen spot, further down the page (an empty page only scrolls so far)

  // Tap the grip to arm it, then drag: the divider moves, and is disarmed again afterwards.
  await marginTap(cdp, geo, mid);
  await expect(grip).toHaveClass(/armed/);
  await marginDrag(cdp, geo, mid, mid + 150);
  await expect(grip).not.toHaveClass(/armed/);
  expect(await gripTop()).toBeGreaterThan(g0 + 100);
  const moved = await gripTop();
  await marginDrag(cdp, geo, mid + 150, mid - 100); // scrolls again, divider stays
  expect(Math.abs((await gripTop()) - moved)).toBeLessThan(1);

  // The position is remembered.
  await page.reload();
  await attachBoard(page);
  expect(Math.abs((await gripTop()) - moved)).toBeLessThan(2);
});
