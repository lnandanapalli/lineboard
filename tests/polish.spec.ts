import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, PEN, send, setup, stripY, tp } from './helpers';
import { mockSupabase } from './mockSupabase';

/** Small fixes: the title field, the mode menu, colour choice, tool cursors, the sidebar. */

const openSidebar = async (page: Page) => {
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.waitForTimeout(300);
};

test('editing the title, then pressing the board, saves it and leaves the field', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const title = page.locator('.title-input');
  await title.click();
  await title.fill('Renamed by tapping away');
  await send(cdp, 'touchStart', [tp(geo.areaX + 300, stripY(geo, 3), PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect(title).not.toBeFocused();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]')[0]?.title)).toBe('Renamed by tapping away');
  // A mouse click on the board does the same.
  await title.click();
  await title.fill('And by clicking');
  await page.mouse.click(geo.areaX + 300, stripY(geo, 4));
  await expect(title).not.toBeFocused();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]')[0]?.title)).toBe('And by clicking');
});

test('the open mode menu follows a mode changed with its keyboard shortcut', async ({ page }) => {
  await setup(page);
  await page.locator('.mode-btn').click();
  const menu = page.getByRole('menu', { name: 'Mode' });
  await expect(menu.getByRole('menuitemradio', { name: /Strips/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('f');
  await expect(menu.getByRole('menuitemradio', { name: /Free whiteboard/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: /Strips/ })).toHaveAttribute('aria-checked', 'false');
});

test('the chosen colour has a ring and a check that show on any colour, black included', async ({ page }) => {
  await setup(page);
  const chosen = page.locator('.swatch[aria-pressed=true]');
  await expect(chosen).toHaveCount(1);
  // Black is the default pen colour: the check on it is white.
  await expect(chosen.locator('svg')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.locator('.swatch').nth(1).click();
  await expect(page.locator('.swatch').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.swatch[aria-pressed=true]')).toHaveCount(1);
  const ring = await page.locator('.swatch').nth(1).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).toContain('0px 0px 0px 4px'); // the outer ring
});

test('the pen and highlighter cursors differ, each showing its tip', async ({ page }) => {
  const { geo } = await setup(page);
  const cursor = () => page.locator('canvas.live').evaluate((c) => (c as HTMLElement).style.cursor);
  await page.mouse.move(geo.areaX + 300, stripY(geo, 2));
  await page.mouse.move(geo.areaX + 310, stripY(geo, 2));
  const pen = await cursor();
  expect(pen).toContain('data:image/svg+xml');
  expect(decodeURIComponent(pen)).toContain('<circle');
  await page.keyboard.press('h');
  await page.mouse.move(geo.areaX + 320, stripY(geo, 2));
  const hl = await cursor();
  expect(decodeURIComponent(hl)).toContain('<rect');
  expect(decodeURIComponent(hl)).toContain('fill-opacity="0.45"');
  expect(hl).not.toBe(pen);
});

test('a name cut short in the sidebar shows in full on hover; one that fits does not', async ({ page }) => {
  await setup(page);
  const long = 'A very long note title about thermodynamics, entropy and the arrow of time, part two';
  await page.locator('.title-input').fill(long);
  await page.locator('.title-input').press('Enter');
  await openSidebar(page);
  await page.locator('.note-title', { hasText: 'thermodynamics' }).hover();
  await expect(page.locator('.name-tip')).toHaveText(long);
  await page.mouse.move(5, 600);
  await expect(page.locator('.name-tip')).toHaveCount(0);
  await page.locator('.title-input').fill('Short');
  await page.locator('.title-input').press('Enter');
  await page.locator('.note-title', { hasText: 'Short' }).hover();
  await page.waitForTimeout(200);
  await expect(page.locator('.name-tip')).toHaveCount(0);
});

test('the sidebar can be dragged wider or narrower, within limits, and is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(page);
  await openSidebar(page);
  const width = () => page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(await width()).toBe(320);
  const handle = page.getByRole('separator', { name: 'Resize the sidebar' });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBe(420);
  // Never wider than the limit (560 px here), never narrower than 240 px.
  await page.mouse.move(x + 100, y);
  await page.mouse.down();
  await page.mouse.move(x + 900, y, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBe(560);
  const b2 = (await handle.boundingBox())!;
  await page.mouse.move(b2.x + 5, y);
  await page.mouse.down();
  await page.mouse.move(0, y, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBe(240);
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  expect(await width()).toBe(240);
  await handle.dblclick();
  expect(await width()).toBe(320);
});

test('signed in, the sidebar does not show the email address', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 50, stripY(geo, 0), geo.areaX + 150, stripY(geo, 0));
  await openSidebar(page);
  await expect(page.locator('.sidebar')).not.toContainText('friend@example.com');
  await expect(page.locator('.sidebar-foot')).toContainText('Synced to your account');
});
