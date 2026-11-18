import { expect, test, type Page } from '@playwright/test';
import { PEN, attachBoard, send, setup, stripY, tp } from './helpers';

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
const measure = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    const p: number[] = list[list.length - 1].points;
    let wiggle = 0;
    for (let i = 4; i < p.length; i += 3) wiggle += Math.abs(p[i] - p[i - 3]);
    return { wiggle, endX: p[p.length - 3] };
  });

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
