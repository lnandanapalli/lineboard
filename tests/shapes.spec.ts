import { expect, test, type Page } from '@playwright/test';
import { drag, expectStrokes, setup, stripY } from './helpers';

/** Shapes are saved as pen strokes that trace the outline. */

async function pickShape(page: Page, name: string) {
  await page.locator('.shape-btn').click();
  await page.getByRole('menuitemradio', { name: new RegExp('^' + name) }).click();
}

const lastPoints = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    const p: number[] = list[list.length - 1].points;
    const xy: [number, number][] = [];
    for (let i = 0; i < p.length; i += 3) xy.push([p[i], p[i + 1]]);
    return { xy, tool: list[list.length - 1].tool as string };
  });

test('rectangle with sharp corners, square with Shift, arrow and ellipse', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // Free mode, so shapes can span strips.
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Free whiteboard/ }).click();
  await page.waitForTimeout(150);
  const area = (await page.locator('.canvas-area').boundingBox())!;
  const scale = area.width / 1000;
  const at = (x: number, y: number) => ({ x: area.x + x * scale, y: area.y + y * scale });

  await pickShape(page, 'Rectangle');
  await expect(page.locator('.shape-btn')).toHaveClass(/active/);
  let a = at(100, 100), b = at(300, 200);
  await drag(cdp, a.x, a.y, b.x, b.y);
  await expectStrokes(page, 1);
  let r = await lastPoints(page);
  expect(r.tool).toBe('pen');
  // Five doubled corners: (100,100) (300,100) (300,200) (100,200) back to (100,100)
  const corners = r.xy.filter((_, i) => i % 2 === 0).map(([x, y]) => [Math.round(x / 5) * 5, Math.round(y / 5) * 5]);
  expect(corners).toEqual([[100, 100], [300, 100], [300, 200], [100, 200], [100, 100]]);

  // Shift: a square, using the larger side.
  a = at(400, 100);
  b = at(500, 300);
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expectStrokes(page, 2);
  r = await lastPoints(page);
  const xs = r.xy.map((p) => p[0]), ys = r.xy.map((p) => p[1]);
  expect(Math.round(Math.max(...xs) - Math.min(...xs))).toBe(Math.round(Math.max(...ys) - Math.min(...ys)));

  await pickShape(page, 'Arrow');
  a = at(100, 400);
  b = at(400, 400);
  await drag(cdp, a.x, a.y, b.x, b.y);
  await expectStrokes(page, 3);
  r = await lastPoints(page);
  expect(r.xy.length).toBe(8); // shaft + two barbs

  await pickShape(page, 'Ellipse');
  a = at(500, 400);
  b = at(700, 500);
  await drag(cdp, a.x, a.y, b.x, b.y);
  await expectStrokes(page, 4);
  r = await lastPoints(page);
  expect(r.xy.length).toBeGreaterThan(24);

  // A tap draws nothing; undo removes a shape like any stroke.
  await drag(cdp, a.x, a.y, a.x + 1, a.y);
  await page.waitForTimeout(200);
  await expectStrokes(page, 4);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectStrokes(page, 3);
});

test('S picks the shape tool, which uses the pen colour', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('s');
  await expect(page.locator('.shape-btn')).toHaveClass(/active/);
  await expect(page.locator('.size-btn')).toHaveAttribute('aria-label', /^Pen size/);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0) - 20, geo.areaX + 300, stripY(geo, 0) + 20);
  await expectStrokes(page, 1);
});
