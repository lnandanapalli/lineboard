import { expect, test } from '@playwright/test';
import { drag, savedStrokes, setup, stripY } from './helpers';

/** Data safety under pressure: full storage, other tabs, other devices, slow uploads. */

test('with the device’s storage full, ink is not reported saved, is kept, and is saved once there is room', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // The browser refuses to store more ink (the queue itself still fits).
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    (window as unknown as { __full: boolean }).__full = true;
    Storage.prototype.setItem = function (k: string, v: string) {
      if ((window as unknown as { __full: boolean }).__full && k.startsWith('lb-local-strokes-')) throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await drag(cdp, geo.areaX + 50, stripY(geo, 0), geo.areaX + 200, stripY(geo, 0));
  await expect(page.locator('#toast')).toContainText('storage is full');
  await expect(page.locator('.status')).toHaveText('Not saved yet, will retry');
  expect(await savedStrokes(page)).toBe(0);
  // Still waiting, and kept for a reload.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-queue-local:')).length)).toBe(1);

  // Space is freed: the retry saves it.
  await page.evaluate(() => ((window as unknown as { __full: boolean }).__full = false));
  await expect.poll(() => savedStrokes(page), { timeout: 15_000 }).toBe(1);
  await expect(page.locator('.status')).toHaveText('Saved on device');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-queue-local:')).length)).toBe(0);
});
