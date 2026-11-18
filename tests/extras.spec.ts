import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { PEN, drag, expectStrokes, send, setup, stripY, tp } from './helpers';

/** Select (lasso, move, duplicate, delete), custom colours and whiteboard paper. */

const strokes = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'));
    return k ? (JSON.parse(localStorage[k]) as { id: string; color: string; points: number[] }[]) : [];
  });

async function loop(cdp: CDPSession, cx: number, cy: number, rx: number, ry: number) {
  await send(cdp, 'touchStart', [tp(cx + rx, cy, PEN, 4)]);
  for (let i = 1; i <= 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    await send(cdp, 'touchMove', [tp(cx + rx * Math.cos(t), cy + ry * Math.sin(t), PEN, 4)]);
  }
  await send(cdp, 'touchEnd', []);
}

async function freeBoard(page: Page) {
  const { cdp } = await setup(page);
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Free whiteboard/ }).click();
  await page.waitForTimeout(150);
  const b = (await page.locator('.canvas-area').boundingBox())!;
  return { cdp, b };
}

test('lasso selects, drags, duplicates and deletes strokes, with undo', async ({ page }) => {
  const { cdp, b } = await freeBoard(page);
  const y1 = b.y + 120, y2 = b.y + 180, y3 = b.y + 500;
  await drag(cdp, b.x + 100, y1, b.x + 300, y1);
  await drag(cdp, b.x + 100, y2, b.x + 300, y2);
  await drag(cdp, b.x + 100, y3, b.x + 300, y3); // left out of the loop
  await expectStrokes(page, 3);

  await page.keyboard.press('v');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveClass(/active/);
  await loop(cdp, b.x + 200, (y1 + y2) / 2, 160, 90);
  const bar = page.locator('.select-bar');
  await expect(bar).toBeVisible();

  // Drag from inside the selection.
  const before = await strokes(page);
  await drag(cdp, b.x + 200, y1, b.x + 200, y1 + 150);
  await expect.poll(async () => (await strokes(page))[0].points[1]).toBeGreaterThan(before[0].points[1] + 100);
  const after = await strokes(page);
  expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort()); // same strokes, moved
  expect(after.find((s) => s.id === before[2].id)!.points).toEqual(before[2].points); // the third one stayed

  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await strokes(page)).find((s) => s.id === before[0].id)!.points[1]).toBe(before[0].points[1]);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(async () => (await strokes(page)).find((s) => s.id === before[0].id)!.points[1]).toBe(after.find((s) => s.id === before[0].id)!.points[1]);

  // Undo/redo replaces the strokes, so select the moved pair again.
  await loop(cdp, b.x + 200, (y1 + y2) / 2 + 150, 160, 90);
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Duplicate' }).click();
  await expectStrokes(page, 5);
  await page.keyboard.press('Delete'); // deletes the selected copies
  await expectStrokes(page, 3);
  await expect(bar).toHaveCount(0);
});

test('a tap with the select tool picks the stroke under it', async ({ page }) => {
  const { cdp, b } = await freeBoard(page);
  await drag(cdp, b.x + 100, b.y + 150, b.x + 400, b.y + 150);
  await page.keyboard.press('v');
  await send(cdp, 'touchStart', [tp(b.x + 250, b.y + 151, PEN, 4)]);
  await send(cdp, 'touchEnd', []);
  await expect(page.locator('.select-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-bar')).toHaveCount(0);
});

test('a custom colour is used for new ink and shows as a swatch', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.locator('.color-input').fill('#14b8a6');
  await expect(page.locator('.swatch.active')).toHaveAttribute('title', '#14b8a6');
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(async () => (await strokes(page))[0]?.color).toBe('#14b8a6');
});

test('the whiteboard paper is a saved setting', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Page & writing' }).click();
  await page.getByLabel('Free whiteboard paper').selectOption('grid');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lb-settings-local')!).paper)).toBe('grid');
});
