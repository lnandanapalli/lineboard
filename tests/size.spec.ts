import { expect, test } from '@playwright/test';
import { drag, setup, stripY, savesDone } from './helpers';

/** Pen and highlighter size come from a slider (with quick presets), and each tool keeps its own. */

const lastWidth = async (page: import('@playwright/test').Page) => {
  await savesDone(page);
  return page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
    const list = JSON.parse(localStorage[k]);
    return list[list.length - 1].width as number;
  });
};

test('the size slider sets the width of new strokes, per tool', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const sizeBtn = page.locator('.size-btn');
  await expect(sizeBtn).toHaveAttribute('aria-label', 'Pen size: 3.5');

  await sizeBtn.click();
  const slider = page.getByRole('slider', { name: 'Pen size' });
  await slider.fill('10');
  await expect(sizeBtn).toHaveAttribute('aria-label', 'Pen size: 10');
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover')).toHaveCount(0);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(() => lastWidth(page)).toBe(10);

  // The highlighter has its own size; presets work too.
  await page.keyboard.press('h');
  await expect(sizeBtn).toHaveAttribute('aria-label', 'Highlighter size: 22');
  await sizeBtn.click();
  await page.locator('.popover').getByRole('button', { name: 'Thick' }).click();
  await expect(sizeBtn).toHaveAttribute('aria-label', 'Highlighter size: 32');
  await sizeBtn.click(); // pressing the button again closes it
  await expect(page.locator('.popover')).toHaveCount(0);

  // Remembered after a reload.
  await page.keyboard.press('p');
  await page.reload();
  await expect(page.locator('.size-btn')).toHaveAttribute('aria-label', 'Pen size: 10');
});
