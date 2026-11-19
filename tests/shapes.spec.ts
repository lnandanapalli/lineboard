import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { drag, expectStrokes, setup, stripY } from './helpers';

/** Shapes come from a palette and are saved as pen strokes that trace the outline. No keyboard needed. */

async function pickShape(page: Page, name: string) {
  await page.locator('.shape-btn').click();
  await page.locator('.shape-grid').getByRole('radio', { name, exact: true }).click();
  await expect(page.locator('.shape-palette')).toHaveCount(0); // picking closes the palette
}

const all = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'));
    return k ? (JSON.parse(localStorage[k]) as { tool: string; points: number[] }[]) : [];
  });
const box = (points: number[]) => {
  const xs = points.filter((_, i) => i % 3 === 0), ys = points.filter((_, i) => i % 3 === 1);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

async function freeBoard(page: Page) {
  const { cdp } = await setup(page);
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Free whiteboard/ }).click();
  await page.waitForTimeout(150);
  const area = (await page.locator('.canvas-area').boundingBox())!;
  const scale = area.width / 1000;
  const at = (x: number, y: number) => ({ x: area.x + x * scale, y: area.y + y * scale });
  const draw = async (x0: number, y0: number, x1: number, y1: number) => {
    const a = at(x0, y0), b = at(x1, y1);
    await drag(cdp as CDPSession, a.x, a.y, b.x, b.y);
  };
  return { cdp, draw };
}

test('the palette offers every shape, and each one draws', async ({ page }) => {
  const { draw } = await freeBoard(page);
  await page.locator('.shape-btn').click();
  const cells = page.locator('.shape-grid [role=radio]');
  await expect(cells).toHaveCount(18);
  const names = await cells.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
  await page.keyboard.press('Escape');
  let n = 0;
  for (const [i, name] of names.entries()) {
    await pickShape(page, name);
    const x = 60 + (i % 6) * 150, y = 60 + Math.floor(i / 6) * 150;
    await draw(x, y, x + 110, y + 90);
    n += name === 'Crossed box' ? 3 : name === 'Check box' ? 2 : 1;
    await expectStrokes(page, n);
  }
});

test('rectangles have exact corners; nearly-square boxes snap to squares without a keyboard', async ({ page }) => {
  const { draw } = await freeBoard(page);
  await pickShape(page, 'Rectangle');
  await expect(page.locator('.shape-btn')).toHaveClass(/active/);
  await draw(100, 100, 300, 200);
  await expectStrokes(page, 1);
  let s = (await all(page)).at(-1)!;
  expect(s.tool).toBe('pen');
  const corners: number[][] = [];
  for (let i = 0; i < s.points.length; i += 6) corners.push([Math.round(s.points[i] / 5) * 5, Math.round(s.points[i + 1] / 5) * 5]);
  expect(corners).toEqual([[100, 100], [300, 100], [300, 200], [100, 200], [100, 100]]);

  // 200 x 182: close enough to square that it becomes one.
  await draw(400, 100, 600, 282);
  await expectStrokes(page, 2);
  s = (await all(page)).at(-1)!;
  expect(Math.round(box(s.points).w)).toBe(Math.round(box(s.points).h));

  // A circle the same way.
  await pickShape(page, 'Ellipse');
  await draw(650, 100, 830, 262);
  await expectStrokes(page, 3);
  s = (await all(page)).at(-1)!;
  expect(Math.abs(box(s.points).w - box(s.points).h)).toBeLessThan(1);
});

test('Keep proportions forces equal sides, and lines snap to 45°', async ({ page }) => {
  const { draw } = await freeBoard(page);
  await page.locator('.shape-btn').click();
  await page.getByRole('switch', { name: 'Keep proportions' }).click();
  await expect(page.getByRole('switch', { name: 'Keep proportions' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('.shape-grid').getByRole('radio', { name: 'Rectangle', exact: true }).click();
  await draw(100, 100, 400, 160); // clearly oblong, still a square
  await expectStrokes(page, 1);
  const sq = box((await all(page)).at(-1)!.points);
  expect(Math.round(sq.w)).toBe(Math.round(sq.h));

  await page.locator('.shape-btn').click();
  await page.getByRole('switch', { name: 'Keep proportions' }).click(); // off again
  await page.locator('.shape-grid').getByRole('radio', { name: 'Line', exact: true }).click();
  await draw(100, 500, 300, 690); // ~44°: snaps to exactly 45°
  await expectStrokes(page, 2);
  const ln = box((await all(page)).at(-1)!.points);
  expect(Math.round(ln.w)).toBe(Math.round(ln.h));
});

test('a crossed box is one undo step, and a tap draws nothing', async ({ page }) => {
  const { draw } = await freeBoard(page);
  await pickShape(page, 'Crossed box');
  await draw(100, 100, 300, 300);
  await expectStrokes(page, 3);
  await draw(500, 500, 501, 500);
  await page.waitForTimeout(200);
  await expectStrokes(page, 3);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectStrokes(page, 0);
});

test('S picks the shape tool, which uses the pen colour and size', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('s');
  await expect(page.locator('.shape-btn')).toHaveClass(/active/);
  await expect(page.locator('.size-btn')).toHaveAttribute('aria-label', /^Pen size/);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0) - 20, geo.areaX + 300, stripY(geo, 0) + 20);
  await expectStrokes(page, 1);
});
