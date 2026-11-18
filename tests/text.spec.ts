import { expect, test, type Page } from '@playwright/test';
import { PEN, expectStrokes, send, setup, stripY, tapMargin, tp } from './helpers';
import { MOCK_URL, mockSupabase } from './mockSupabase';

/** Text boxes: tap with the Text tool, type, and tap again to edit. */

const texts = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'));
    return k ? (JSON.parse(localStorage[k]) as { tool: string; text?: string }[]).filter((s) => s.tool === 'text').map((s) => s.text) : [];
  });

async function tap(cdp: import('@playwright/test').CDPSession, x: number, y: number) {
  await send(cdp, 'touchStart', [tp(x, y, PEN, 3)]);
  await send(cdp, 'touchEnd', []);
}

test('type a text box, edit it, undo the edit, and empty it to remove it', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.size-btn')).toHaveAttribute('aria-label', 'Text size: 28');

  const x = geo.areaX + 120, y = stripY(geo, 0);
  await tap(cdp, x, y);
  const editor = page.locator('textarea.text-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Hello');
  await page.keyboard.press('Enter');
  await page.keyboard.type('world p'); // "p" must not switch to the pen while typing
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect.poll(() => texts(page)).toEqual(['Hello\nworld p']);
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(/active/);

  // Tap the text again to edit it.
  await tap(cdp, x + 5, y);
  await expect(editor).toHaveValue('Hello\nworld p');
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect.poll(() => texts(page)).toEqual(['Hello\nworld p!']);
  await expectStrokes(page, 1);

  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(() => texts(page)).toEqual(['Hello\nworld p']);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(() => texts(page)).toEqual(['Hello\nworld p!']);

  // Emptying it removes it.
  await tap(cdp, x + 5, y);
  await editor.fill('');
  await page.keyboard.press('Escape');
  await expect.poll(() => texts(page)).toEqual([]);
  await expectStrokes(page, 0);
});

test('switching tools finishes the text box, and the eraser removes it', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 120, stripY(geo, 0));
  await page.keyboard.type('Note');
  await page.getByRole('button', { name: 'Eraser', exact: true }).click();
  await expect.poll(() => texts(page)).toEqual(['Note']);
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 125, y, PEN, 1)]);
  await send(cdp, 'touchMove', [tp(geo.areaX + 130, y, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect.poll(() => texts(page)).toEqual([]);
});

test('with a database that predates text boxes, the Text tool explains instead of failing', async ({ page }) => {
  await mockSupabase(page);
  // The probe for the strokes.text column fails like an old schema does.
  await page.route(`${MOCK_URL}/rest/v1/strokes?select=text*`, (r) =>
    r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42703', message: 'column strokes.text does not exist' }) }),
  );
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.canvas-area canvas.live').waitFor();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('database update');
  await expect(page.getByRole('button', { name: 'Pen', exact: true })).toHaveClass(/active/);
});

test('text boxes sync to the account and come back after a reload', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const { attachBoard } = await import('./helpers');
  let { cdp, geo } = await attachBoard(page);
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(/active/);
  await tap(cdp, geo.areaX + 120, stripY(geo, 0));
  await page.keyboard.type('Synced');
  await page.keyboard.press('Escape');
  await expect.poll(() => db.strokes.map((s) => [s.tool, s.text])).toEqual([['text', 'Synced']]);

  await page.reload();
  ({ cdp, geo } = await attachBoard(page));
  // Once the note has loaded, the first empty strip below the content is unlocked; unlock strip 0 to edit.
  await expect(page.getByLabel('Lock strip 2', { exact: true })).toBeAttached();
  await tapMargin(cdp, geo, 0);
  await expect(page.getByLabel('Lock strip 1', { exact: true })).toBeAttached(); // strip 0 is the unlocked one now
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(/active/); // after the schema check
  await tap(cdp, geo.areaX + 125, stripY(geo, 0));
  await expect(page.locator('textarea.text-editor')).toHaveValue('Synced');
});
