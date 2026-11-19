import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { setup } from './helpers';
import { mockSupabase } from './mockSupabase';
import { withDefaults, DEFAULT_SETTINGS } from '../src/types';
import { clip } from '../src/limits';

/** Every input has a minimum and a maximum; the app stops people early, with a reason. */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));
type S = { tool: string; points: number[]; text?: string };
const strokes = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-local-strokes-')).flatMap((k) => JSON.parse(localStorage[k]) as S[]));

test('a very long stroke is saved in pieces of at most 20,000 points that join up', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const c = document.querySelector('canvas.live')!;
    const r = c.getBoundingClientRect();
    const at = (i: number) => ({ clientX: r.left + 40 + (i % 2 ? 3 : 0) + (i % 300) * 1.2, clientY: r.top + 30 + Math.floor(i / 300) * 0.05 });
    const fire = (type: string, i: number) => c.dispatchEvent(new PointerEvent(type, { ...at(i), pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true, bubbles: true, pressure: 0.5 }));
    fire('pointerdown', 0);
    for (let i = 1; i <= 25_000; i++) fire('pointermove', i);
    fire('pointerup', 25_000);
  });
  await expect.poll(async () => (await strokes(page)).length).toBe(2);
  const [a, b] = (await strokes(page)).sort((x, y) => y.points.length - x.points.length);
  expect(a.points.length).toBeLessThanOrEqual(60_000);
  expect(a.points.length + b.points.length).toBeGreaterThan(60_000);
  // The second piece starts where the first ended.
  const all = await strokes(page);
  const first = all.find((s) => s.points.length === 60_000)!;
  const second = all.find((s) => s !== first)!;
  expect(second.points.slice(0, 2)).toEqual(first.points.slice(-3, -1));
});

test('names and titles are capped where they are typed', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.title-input')).toHaveAttribute('maxlength', '200');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.waitForTimeout(300);
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  const field = page.locator('dialog[open] .dlg-input');
  await expect(field).toHaveAttribute('maxlength', '120');
  await field.fill('n'.repeat(500));
  await expect(field).toHaveValue('n'.repeat(120));
  await page.locator('dialog[open]').getByRole('button', { name: 'Create' }).click();
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('lb-local-notebooks') ?? '[]') as { name: string }[]).map((b) => b.name.length))).toContain(120);
});

test('at most 20 pictures are added at once, and the rest are named in a message', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  const files = Array.from({ length: 22 }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: PNG }));
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles(files);
  await expect(page.locator('#toast')).toContainText('at most 20 at a time');
  await expect.poll(async () => (await strokes(page)).filter((s) => s.tool === 'image').length, { timeout: 30_000 }).toBe(20);
});

test('when the browser’s storage is full, the app says waiting changes are at risk', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.startsWith('lb-queue')) throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  const { drag, stripY } = await import('./helpers');
  await drag(cdp, geo.areaX + 50, stripY(geo, 0), geo.areaX + 150, stripY(geo, 0));
  await expect(page.locator('#toast')).toContainText('storage is full');
});

test('sign-in fields are capped: email 254, password 72 characters', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/login');
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('maxlength', '254');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('maxlength', '72');
});

test('stored settings out of range are brought back within it', () => {
  const s = withDefaults({ stripHeight: 99_999, touchThreshold: -1, penWidth: Number.NaN, highlighterWidth: 1e9, smoothing: 5, textSize: 1, splitRatio: 2, penColor: 'javascript:alert(1)', highlighterColor: '#abc', showLines: 'yes' as unknown as boolean, marginSide: 'top' as 'left' });
  expect(s.stripHeight).toBe(220);
  expect(s.touchThreshold).toBe(5);
  expect(s.penWidth).toBe(DEFAULT_SETTINGS.penWidth);
  expect(s.highlighterWidth).toBe(60);
  expect(s.smoothing).toBe(1);
  expect(s.textSize).toBe(10);
  expect(s.splitRatio).toBe(0.85);
  expect(s.penColor).toBe(DEFAULT_SETTINGS.penColor);
  expect(s.highlighterColor).toBe('#abc');
  expect(s.showLines).toBe(DEFAULT_SETTINGS.showLines);
  expect(s.marginSide).toBe('left');
});

test('clip trims to a limit without splitting a character', () => {
  expect(clip('  hello  ', 3)).toBe('hel');
  expect(Array.from(clip('😀'.repeat(10), 4))).toHaveLength(4);
  expect(clip('short', 100)).toBe('short');
});
