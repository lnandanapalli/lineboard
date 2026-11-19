import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { PEN, attachBoard, drag, expectStrokes, send, setup, stripY, tp } from './helpers';
import { mockSupabase } from './mockSupabase';

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
  await expect(cells).toHaveCount(19);
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
  await expect(page.locator('.shape-tool')).toHaveClass(/active/);
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
  await expect(page.locator('.shape-tool')).toHaveClass(/active/);
  await expect(page.locator('.size-btn')).toHaveAttribute('aria-label', /^Pen size/);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0) - 20, geo.areaX + 300, stripY(geo, 0) + 20);
  await expectStrokes(page, 1);
});

test('on a short screen the palette scrolls so every shape and the switch can be reached', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await setup(page);
  await page.locator('.shape-btn').click();
  const panel = page.locator('.popover');
  const pb = (await panel.boundingBox())!;
  expect(pb.y + pb.height).toBeLessThanOrEqual(390);
  const lock = page.getByRole('switch', { name: 'Keep proportions' });
  await lock.scrollIntoViewIfNeeded();
  await lock.click();
  await expect(lock).toHaveAttribute('aria-checked', 'true');
  await page.locator('.shape-grid').getByRole('radio', { name: 'Arrow line', exact: true }).click();
  await expect(page.locator('.shape-tool .split-main')).toHaveAttribute('aria-label', 'Shapes: Arrow line');
});

test('shapes can be dashed or dotted and thin to extra bold; the choice is saved with the shape', async ({ page }) => {
  const { draw } = await freeBoard(page);
  await page.locator('.shape-btn').click();
  await page.getByRole('radiogroup', { name: 'Line style' }).getByRole('radio', { name: 'Dashed' }).click();
  await page.getByRole('radiogroup', { name: 'Thickness' }).getByRole('radio', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Dashed' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('.shape-grid').getByRole('radio', { name: 'Line', exact: true }).click();
  await draw(100, 300, 900, 300);
  await expectStrokes(page, 1);
  let s = (await all(page)).at(-1)! as { width: number; dash?: string };
  expect(s).toMatchObject({ width: 6, dash: 'dashed' });

  // The line really has gaps: on the ink canvas, the row through it is part ink, part blank.
  const gaps = () =>
    page.evaluate(() => {
      const c = document.querySelectorAll<HTMLCanvasElement>('.canvas-area canvas')[1];
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let best = { ink: 0, blank: 0 };
      for (let y = 0; y < c.height; y++) {
        let ink = 0;
        for (let x = Math.round(c.width * 0.25); x < Math.round(c.width * 0.75); x++) if (d[(y * c.width + x) * 4 + 3] > 128) ink++;
        if (ink > best.ink) best = { ink, blank: Math.round(c.width * 0.5) - ink };
      }
      return best;
    });
  await expect.poll(async () => (await gaps()).ink).toBeGreaterThan(50);
  const g = await gaps();
  expect(g.blank).toBeGreaterThan(50);

  // Dotted, extra bold.
  await page.locator('.shape-btn').click();
  await page.getByRole('radio', { name: 'Dotted' }).click();
  await page.getByRole('radio', { name: 'Extra bold' }).click();
  await page.locator('.shape-grid').getByRole('radio', { name: 'Double arrow line', exact: true }).click();
  await draw(100, 500, 900, 500);
  await expectStrokes(page, 2);
  s = (await all(page)).at(-1)! as { width: number; dash?: string };
  expect(s).toMatchObject({ width: 10, dash: 'dotted' });

  // Solid again: no dash saved. The choices are remembered after a reload.
  await page.locator('.shape-btn').click();
  await page.getByRole('radio', { name: 'Solid' }).click();
  await page.keyboard.press('Escape');
  await draw(100, 700, 400, 800);
  await expectStrokes(page, 3);
  expect((await all(page)).at(-1)).not.toHaveProperty('dash');
  await page.reload();
  await page.locator('.shape-btn').click();
  await expect(page.getByRole('radio', { name: 'Solid' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Extra bold' })).toHaveAttribute('aria-checked', 'true');
});

test('an account keeps the line style: saved with the stroke and read back on another load', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const { cdp, geo } = await attachBoard(page);
  await page.locator('.shape-btn').click();
  await page.getByRole('radio', { name: 'Dotted' }).click();
  await page.locator('.shape-grid').getByRole('radio', { name: 'Line', exact: true }).click();
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 400, stripY(geo, 0));
  await expect.poll(() => db.strokes.length).toBe(1);
  expect(db.strokes[0].dash).toBe('dotted');
  // Loaded back from the server, it is still drawn dotted: the row through it switches between
  // ink and blank many times (a solid line would switch twice).
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  const switches = () =>
    page.evaluate(() => {
      const c = document.querySelectorAll<HTMLCanvasElement>('.canvas-area canvas')[1];
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let best = 0, bestInk = 0;
      for (let y = 0; y < c.height; y++) {
        let ink = 0, sw = 0, prev = false;
        for (let x = 0; x < c.width; x++) {
          const on = d[(y * c.width + x) * 4 + 3] > 128;
          if (on) ink++;
          if (on !== prev) sw++;
          prev = on;
        }
        if (ink > bestInk) [bestInk, best] = [ink, sw];
      }
      return best;
    });
  await expect.poll(switches).toBeGreaterThan(20);
});

test('resizing a dashed shape previews it at the new size while dragging', async ({ page }) => {
  const { cdp, draw } = await freeBoard(page);
  await page.locator('.shape-btn').click();
  await page.getByRole('radio', { name: 'Dashed' }).click();
  await page.locator('.shape-grid').getByRole('radio', { name: 'Rectangle', exact: true }).click();
  await draw(200, 200, 400, 350);
  await expectStrokes(page, 1);
  // Select it with a box, then hold the resize handle and drag it out without letting go.
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  await draw(150, 150, 450, 400);
  await expect(page.locator('.select-bar')).toBeVisible();
  const area = (await page.locator('.canvas-area').boundingBox())!;
  const k = area.width / 1000;
  const at = (x: number, y: number) => [area.x + x * k, area.y + y * k] as const;
  const [hx, hy] = at(407, 357);
  await send(cdp, 'touchStart', [tp(hx, hy, PEN, 1)]);
  for (let i = 1; i <= 8; i++) {
    const [x, y] = at(407 + i * 40, 357 + i * 30);
    await send(cdp, 'touchMove', [tp(x, y, PEN, 1)]);
  }
  // The preview (live layer) has the shape's ink well beyond its old right edge.
  const inkRight = () =>
    page.evaluate((edge) => {
      const c = document.querySelectorAll<HTMLCanvasElement>('.canvas-area canvas')[2];
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const x0 = Math.round(c.width * edge);
      let n = 0;
      for (let y = 0; y < c.height; y++)
        for (let x = x0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i + 3] > 128 && d[i + 2] < 100) n++; // dark ink, not the blue selection box
        }
      return n;
    }, 0.55);
  await expect.poll(inkRight).toBeGreaterThan(200);
  await send(cdp, 'touchEnd', []);
});

test('the Select and Shapes icons pick the tool with the last choice; only the arrow opens the menu', async ({ page }) => {
  const { draw } = await freeBoard(page);
  // Choose the star once from the palette, then switch to the pen.
  await pickShape(page, 'Star');
  await page.keyboard.press('p');
  await expect(page.locator('.shape-tool')).not.toHaveClass(/active/);
  // Pressing the star icon itself goes straight back to drawing stars, with no palette.
  await page.getByRole('button', { name: 'Shapes: Star' }).click();
  await expect(page.locator('.shape-tool')).toHaveClass(/active/);
  await expect(page.locator('.shape-palette')).toHaveCount(0);
  await draw(300, 300, 500, 500);
  await expectStrokes(page, 1);

  // Same for Select: pick Rectangle select from the menu once, leave, then press the icon.
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  await page.keyboard.press('p');
  await page.getByRole('button', { name: 'Select: Rectangle select' }).click();
  await expect(page.locator('.select-tool')).toHaveClass(/active/);
  await expect(page.locator('.dropdown-menu')).toHaveCount(0);
  // A dragged box selects the star.
  await draw(250, 250, 550, 550);
  await expect(page.locator('.select-bar')).toBeVisible();
});
