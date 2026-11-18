import { expect, test, type Page } from '@playwright/test';
import { PEN, expectStrokes, send, tp } from './helpers';

/** Manual orientation: the app turns a quarter at a time and touch input follows it. */

async function turnOn(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Page & writing' }).click();
  await page.getByRole('switch', { name: 'Manual orientation' }).click();
  await page.locator('.settings-close').click();
}

/** Geometry of the board in the app's own (rotated) coordinates, for a 90° turn. */
async function rotatedGeometry(page: Page) {
  return page.evaluate(() => {
    const W = innerWidth;
    // Screen -> app for 90°: (x, y) -> (y, W - x)
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      const xs = [r.top, r.bottom];
      const ys = [W - r.left, W - r.right];
      return { left: Math.min(...xs), top: Math.min(...ys), width: Math.abs(xs[1] - xs[0]), height: Math.abs(ys[1] - ys[0]) };
    };
    const area = rect(document.querySelector('.canvas-area')!);
    const margin = rect(document.querySelector('.margin')!);
    return { W, area, margin, stripPx: (90 * area.width) / 1000 };
  });
}

test('rotating turns the app and pen input lands where it is drawn', async ({ page }) => {
  await page.goto('/app');
  await page.locator('.canvas-area canvas.live').waitFor();
  if (await page.locator('.hint .link').isVisible()) await page.locator('.hint .link').click();
  await expect(page.getByRole('button', { name: 'Rotate right' })).toBeHidden();
  await turnOn(page);
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-rotation', '90');
  await page.waitForTimeout(200);

  const g = await rotatedGeometry(page);
  // App point -> screen point for 90°: (ax, ay) -> (W - ay, ax)
  const toScreen = (ax: number, ay: number) => ({ x: g.W - ay, y: ax });
  const cdp = await page.context().newCDPSession(page);
  const stripCentre = (i: number) => g.area.top + i * g.stripPx + g.stripPx / 2;

  // Tap the lock of strip 3 in the (rotated) margin, then draw across strip 3.
  const lock = toScreen(g.margin.left + g.margin.width / 2, stripCentre(3));
  await send(cdp, 'touchStart', [tp(lock.x, lock.y, PEN, 7)]);
  await send(cdp, 'touchEnd', []);
  await expect(page.locator('.strip-btn.on')).toHaveCount(1);

  const a = toScreen(g.area.left + 100, stripCentre(3));
  const b = toScreen(g.area.left + 500, stripCentre(3));
  await send(cdp, 'touchStart', [tp(a.x, a.y, PEN, 1)]);
  for (let i = 1; i <= 10; i++) await send(cdp, 'touchMove', [tp(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expectStrokes(page, 1);
  const pts: number[] = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    return JSON.parse(localStorage[k])[0].points;
  });
  const ys = pts.filter((_, i) => i % 3 === 1);
  const xs = pts.filter((_, i) => i % 3 === 0);
  expect(Math.min(...ys)).toBeGreaterThan(3 * 90); // inside strip 3 (page units, 90 per strip)
  expect(Math.max(...ys)).toBeLessThan(4 * 90);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(200); // horizontal on the page

  // Four quarter turns bring it back; the choice is per device and survives a reload.
  for (const r of ['180', '270']) {
    await page.getByRole('button', { name: 'Rotate right' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-rotation', r);
  }
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  await expect(page.locator('html')).toHaveAttribute('data-rotation', '270');
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-rotation', /./);
});

test('dialogs and menus turn with the app', async ({ page }) => {
  await page.goto('/app');
  await page.locator('.canvas-area canvas.live').waitFor();
  await turnOn(page);
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // The settings window is drawn outside the app element, so CSS turns it the same quarter.
  expect(await page.locator('dialog.settings-modal').evaluate((d) => getComputedStyle(d).rotate)).toBe('90deg');
  await page.locator('.settings-close').click();
  await page.locator('.mode-btn').click();
  // The menu is inside the rotated app element.
  await expect(page.locator('.app .dropdown-menu')).toBeVisible();
});
