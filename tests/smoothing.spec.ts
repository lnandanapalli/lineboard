import { expect, test, type Page } from '@playwright/test';
import { PEN, attachBoard, send, setup, stripY, tp, savesDone } from './helpers';

/** The smoothing setting steadies shaky lines but still ends the stroke where the pen lifted. */

async function setSmoothing(page: Page, v: number) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Page & writing' }).click();
  await page.getByRole('slider', { name: 'Smoothing' }).fill(String(v));
  await page.locator('.settings-close').click();
}

/** A horizontal line drawn with a ±8 px tremor. */
async function shakyLine(page: Page) {
  const { cdp, geo } = await attachBoard(page);
  const y = stripY(geo, 0);
  const x0 = geo.areaX + 100;
  await send(cdp, 'touchStart', [tp(x0, y, PEN, 1)]);
  for (let i = 1; i <= 40; i++) await send(cdp, 'touchMove', [tp(x0 + i * 10, y + (i % 2 ? 8 : -8), PEN, 1)]);
  await send(cdp, 'touchMove', [tp(x0 + 410, y, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  return { endX: x0 + 410 - geo.areaX, scale: geo.stripPx / 90 };
}

/** Total vertical travel of the newest stroke (page units), and where it ends. */
const measure = async (page: Page) => {
  await savesDone(page);
  return page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    const p: number[] = list[list.length - 1].points;
    let wiggle = 0;
    for (let i = 4; i < p.length; i += 3) wiggle += Math.abs(p[i] - p[i - 3]);
    return { wiggle, endX: p[p.length - 3] };
  });
};

test('smoothing reduces tremor and the stroke still ends at the pen', async ({ page }) => {
  await setup(page);
  await setSmoothing(page, 0);
  await shakyLine(page);
  await expect.poll(async () => (await measure(page)).wiggle).toBeGreaterThan(0);
  const raw = await measure(page);

  await setSmoothing(page, 1);
  const { endX, scale } = await shakyLine(page);
  await expect.poll(async () => (await measure(page)).wiggle).not.toBe(raw.wiggle);
  const smooth = await measure(page);
  expect(smooth.wiggle).toBeLessThan(raw.wiggle * 0.5);
  expect(Math.abs(smooth.endX - endX / scale)).toBeLessThan(1.5);
});

test('quick handwriting keeps small movements and sharp turns at zero smoothing', async ({ page }) => {
  await setup(page);
  await setSmoothing(page, 0);
  const corner = await page.locator('canvas.live').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / 1000;
    const point = (type: string, x: number, y: number, id: number) =>
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerType: 'touch',
        pointerId: id,
        clientX: rect.left + x * scale,
        clientY: rect.top + y * scale,
        width: 6,
        height: 6,
      }));

    point('pointerdown', 100, 45, 1);
    point('pointermove', 100.4, 45, 1);
    point('pointermove', 100.4, 46, 1);
    point('pointerup', 175, 46, 1);

    // A tight reversal at (218, 45), with lift-off reported beyond the last contact.
    point('pointerdown', 200, 45, 2);
    point('pointermove', 218, 45, 2);
    point('pointermove', 204, 57, 2);
    point('pointerup', 250, 57, 2);
    return { x: 218 * scale, y: 45 * scale };
  });

  await savesDone(page);
  const points = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('lb-local-strokes-'))!;
    return JSON.parse(localStorage[key]).map((stroke: { points: number[] }) => stroke.points);
  });
  expect(points).toEqual([
    [100, 45, 0.5, 100.4, 45, 0.5, 100.4, 46, 0.5],
    [200, 45, 0.5, 218, 45, 0.5, 204, 57, 0.5],
  ]);
  await expect.poll(() => page.locator('.canvas-area canvas').nth(1).evaluate((canvas: HTMLCanvasElement, p) => {
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    return canvas.getContext('2d')!.getImageData(Math.floor(p.x * dpr), Math.floor(p.y * dpr), 1, 1).data[3];
  }, corner)).toBeGreaterThan(0);
});

test('fast successive pen letters stay separate across hover, capture loss and reused pointer ids', async ({ page }) => {
  await setup(page);
  await setSmoothing(page, 0);
  await page.locator('canvas.live').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / 1000;
    const fire = (type: string, x: number, down: boolean, pointerId = 7, pointerType = 'pen') => canvas.dispatchEvent(new PointerEvent(type, {
      pointerType, pointerId, isPrimary: true, clientX: rect.left + x * scale, clientY: rect.top + 45 * scale,
      buttons: down ? 1 : 0, pressure: down ? 0.5 : 0,
    }));
    for (const [i, end] of ['pointerup', 'lostpointercapture', 'pointermove', 'missed release', 'pointerup'].entries()) {
      const x = 100 + i * 40;
      fire('pointerdown', x, true);
      fire('pointermove', x + 8, true);
      if (end !== 'missed release') fire(end, x + 35, false);
    }
    fire('pointerdown', 320, true, 8, 'touch');
    fire('pointermove', 328, true, 8, 'touch');
    fire('pointerdown', 360, true, 9, 'touch');
    fire('pointermove', 368, true, 9, 'touch');
    fire('pointerup', 390, false, 9, 'touch');
  });
  await savesDone(page);
  const strokes = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('lb-local-strokes-'))!;
    return JSON.parse(localStorage[key]).map((s: { points: number[] }) => s.points.filter((_, i) => i % 3 === 0));
  });
  expect(strokes).toEqual([[100, 108], [140, 148], [180, 188], [220, 228], [260, 268], [320, 328], [360, 368]]);
});
