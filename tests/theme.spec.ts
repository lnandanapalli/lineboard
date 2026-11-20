import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, setup, stripY } from './helpers';
import { darkInk } from '../src/theme';

/** Light and dark mode: the choice, following the device, and real colours kept in notes and exports. */

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
const strokes = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-local-strokes-')).flatMap((k) => JSON.parse(localStorage[k]) as { color: string }[]));

async function chooseTheme(page: Page, label: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Page & writing' }).click();
  await page.getByRole('combobox', { name: 'Theme' }).selectOption({ label });
  await page.locator('.settings-close').click();
}

test('by default the app follows the device; Light or Dark can be chosen and is remembered', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setup(page);
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light'); // follows the device while it changes
  await chooseTheme(page, 'Dark');
  expect(await theme(page)).toBe('dark');
  await page.reload();
  await attachBoard(page);
  expect(await theme(page)).toBe('dark'); // device is light, the choice wins
  await chooseTheme(page, 'Light');
  expect(await theme(page)).toBe('light');
});

test('in dark mode ink is shown lighter, but notes and exports keep the real colours on white', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { cdp, geo } = await setup(page);
  const y = stripY(geo, 0);
  await drag(cdp, geo.areaX + 40, y, geo.areaX + 400, y);
  await expect.poll(async () => (await strokes(page))[0]?.color).toBe('#111827');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // painted
  // On screen: the page is dark and the black line shows light.
  const onScreen = await page.evaluate(({ x, y }) => {
    const c = document.querySelectorAll<HTMLCanvasElement>('.canvas-area canvas');
    const r = c[0].getBoundingClientRect();
    const k = c[0].width / r.width;
    const px = (cv: HTMLCanvasElement, px: number, py: number) => [...cv.getContext('2d')!.getImageData(Math.round((px - r.left) * k), Math.round((py - r.top) * k), 1, 1).data];
    // The brightest pixel of the line near its middle (it is a few pixels thick).
    let ink = [0, 0, 0, 0];
    for (let dy = -6; dy <= 6; dy++) {
      const p = px(c[1], x + 200, y + dy);
      if (p[3] > 0 && p[0] + p[1] + p[2] > ink[0] + ink[1] + ink[2]) ink = p;
    }
    return { paper: px(c[0], x + 200, y + 30), ink };
  }, { x: geo.areaX, y });
  expect(onScreen.paper.slice(0, 3).every((v) => v < 60)).toBe(true);
  expect(onScreen.ink.slice(0, 3).every((v) => v > 170)).toBe(true);

  // The picture export: white page, dark ink, as drawn.
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share or export', exact: true }).click();
  await page.getByRole('button', { name: /^Picture \(\.png\)/ }).click();
  const png = readFileSync((await (await wait).path())!).toString('base64');
  const exported = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let darkest = 255;
    for (let i = 0; i < d.length; i += 4) darkest = Math.min(darkest, d[i]);
    return { corner: [...ctx.getImageData(2, 2, 1, 1).data], darkest };
  }, png);
  expect(exported.corner.slice(0, 3)).toEqual([255, 255, 255]);
  expect(exported.darkest).toBeLessThan(60);
});

test('dark-page ink keeps its hue and stays readable', () => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const light = (h: string) => Math.max(...rgb(h)) / 255;
  expect(light(darkInk('#111827'))).toBeGreaterThan(0.85); // black shows near-white
  expect(light(darkInk('#ffffff'))).toBeLessThan(0.5); // white shows mid grey
  const [r, g, b] = rgb(darkInk('#2563eb'));
  expect(b).toBeGreaterThan(r); // blue stays blue
  expect(b).toBeGreaterThan(g);
  expect(darkInk('#11182780')).toMatch(/80$/); // transparency kept
  expect(darkInk('not a colour')).toBe('not a colour');
});

test('in dark mode the size button shows the pen as it looks on the page, not black on black', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setup(page);
  const dot = await page.locator('.size-btn .size-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = dot.match(/\d+/g)!.map(Number);
  expect(Math.max(r, g, b)).toBeGreaterThan(170); // a light dot on the dark toolbar
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.locator('.size-btn .size-dot').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(17, 24, 39)');
});
