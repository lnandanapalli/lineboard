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

test('a text box still being typed is saved when the page reloads', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 120, stripY(geo, 0));
  await page.keyboard.type('Draft');
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  await expect.poll(() => texts(page)).toEqual(['Draft']);
});

test('text longer than the database allows is capped instead of being refused', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 120, stripY(geo, 0));
  await page.locator('textarea.text-editor').fill('x'.repeat(10050));
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await texts(page))[0]?.length).toBe(10000);
});

// ---------------- formatting ----------------

type T = { text?: string; width: number; color: string; font?: Record<string, unknown> };
const textBoxes = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'));
    return k ? (JSON.parse(localStorage[k]) as (T & { tool: string })[]).filter((s) => s.tool === 'text') : [];
  });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Text format' });

test('the format bar sets font, size, bold / italic / underline, alignment and colour; the next box starts the same', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 120, stripY(geo, 0));
  await expect(bar(page)).toBeVisible();
  await page.keyboard.type('Styled');
  await bar(page).getByRole('radio', { name: 'Serif' }).click();
  await bar(page).getByRole('button', { name: 'Larger text' }).click(); // 28 -> 36
  await bar(page).getByRole('button', { name: 'Bold' }).click();
  await bar(page).getByRole('button', { name: 'Underline' }).click();
  await bar(page).getByRole('radio', { name: 'Align centre' }).click();
  await bar(page).getByRole('radio', { name: 'Text colour #dc2626' }).click();
  // Pressing the bar keeps typing in the box; the shortcut toggles italic.
  await expect(page.locator('textarea.text-editor')).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+i' : 'Control+i');
  await expect(bar(page).getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(async () => (await textBoxes(page))[0]).toMatchObject({
    text: 'Styled!',
    width: 36,
    color: '#dc2626',
    font: { family: 'serif', bold: true, italic: true, underline: true, align: 'center' },
  });

  // A new text box starts with the same choices.
  await tap(cdp, geo.areaX + 500, stripY(geo, 0));
  await expect(bar(page).getByRole('radio', { name: 'Serif' })).toHaveAttribute('aria-checked', 'true');
  await expect(bar(page).locator('.tb-size')).toHaveText('36');
  await page.keyboard.type('Next');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await textBoxes(page))[1]?.font).toMatchObject({ family: 'serif', bold: true });
});

test('selected text boxes can be reformatted together, in one undo step', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  for (const dx of [100, 400]) {
    await tap(cdp, geo.areaX + dx, stripY(geo, 0));
    await page.keyboard.type('Box');
    await page.keyboard.press('Escape');
  }
  await expect.poll(async () => (await textBoxes(page)).length).toBe(2);
  // Box-select both: the format bar appears above the Duplicate / Delete bar.
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 60, y - 30, PEN, 1)]);
  for (let i = 1; i <= 8; i++) await send(cdp, 'touchMove', [tp(geo.areaX + 60 + i * 60, y + 20, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect(page.locator('.select-bar')).toBeVisible();
  await expect(bar(page)).toBeVisible();
  await bar(page).getByRole('radio', { name: 'Handwriting' }).click();
  await bar(page).getByRole('button', { name: 'Larger text' }).click();
  await expect.poll(async () => (await textBoxes(page)).map((s) => [s.font?.family, s.width])).toEqual([['hand', 36], ['hand', 36]]);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await textBoxes(page)).map((s) => [s.font?.family, s.width])).toEqual([['hand', 28], ['hand', 28]]);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await textBoxes(page)).map((s) => [s.font?.family ?? 'sans', s.width])).toEqual([['sans', 28], ['sans', 28]]);
});

test('an account keeps text formatting: saved with the box and read back after a reload', async ({ page }) => {
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
  await page.keyboard.type('Mono');
  await bar(page).getByRole('radio', { name: 'Mono' }).click();
  await bar(page).getByRole('radio', { name: 'Align right' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => db.strokes[0]?.font).toEqual({ family: 'mono', align: 'right' });

  await page.reload();
  ({ cdp, geo } = await attachBoard(page));
  await expect(page.getByLabel('Lock strip 2', { exact: true })).toBeAttached();
  await tapMargin(cdp, geo, 0);
  await expect(page.getByLabel('Lock strip 1', { exact: true })).toBeAttached();
  await page.keyboard.press('t');
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveClass(/active/);
  await tap(cdp, geo.areaX + 125, stripY(geo, 0));
  await expect(page.locator('textarea.text-editor')).toHaveValue('Mono');
  await expect(bar(page).getByRole('radio', { name: 'Mono' })).toHaveAttribute('aria-checked', 'true');
  await expect(bar(page).getByRole('radio', { name: 'Align right' })).toHaveAttribute('aria-checked', 'true');
});

for (const align of ['Align left', 'Align centre', 'Align right']) {
test(`the box being typed in never clips leaning letters (${align}): it shows as much as the saved text`, async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  const x = geo.areaX + 300, y = stripY(geo, 0);
  await tap(cdp, x, y);
  await bar(page).getByRole('radio', { name: 'Handwriting' }).click();
  await bar(page).getByRole('button', { name: 'Italic' }).click();
  await bar(page).getByRole('button', { name: 'Larger text' }).click();
  await bar(page).getByRole('radio', { name: align }).click();
  await page.keyboard.type('Hello wolf');
  await page.waitForTimeout(300); // the handwriting font is in
  // The rightmost and leftmost dark (ink) pixels in a band around the text.
  const clip = { x: geo.areaX, y: y - 40, width: 700, height: 80 };
  const inkSpan = async () => {
    const png = (await page.screenshot({ clip })).toString('base64');
    return page.evaluate(async (src) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + src;
      await img.decode();
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 110) { // dark ink, not the blue outline
          const px = (i / 4) % c.width;
          min = Math.min(min, px);
          max = Math.max(max, px);
        }
      }
      return [min, max];
    }, png);
  };
  const typing = await inkSpan();
  await page.keyboard.press('Escape');
  await expect(page.locator('textarea.text-editor')).toHaveCount(0);
  const saved = await inkSpan();
  expect(Math.abs(typing[1] - saved[1])).toBeLessThanOrEqual(3);
  expect(Math.abs(typing[0] - saved[0])).toBeLessThanOrEqual(3);
});
}

// ---------------- moving text boxes ----------------

const firstBox = async (page: Page) => (await page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'))!;
  return (JSON.parse(localStorage[k]) as { tool: string; text?: string; points: number[] }[]).filter((s) => s.tool === 'text');
}))[0];

test('with the Text tool, a text box shows the move cursor; dragging moves it and a tap still edits it', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  const x = geo.areaX + 150, y = stripY(geo, 0);
  await tap(cdp, x, y);
  await page.keyboard.type('Move me');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await firstBox(page))?.text).toBe('Move me');
  const live = page.locator('.canvas-area canvas.live');
  // Hover: over the box the cursor says "move"; elsewhere it says "type here".
  await page.mouse.move(x + 10, y);
  await expect(live).toHaveCSS('cursor', 'move');
  await page.mouse.move(x + 400, y);
  await expect(live).toHaveCSS('cursor', 'text');

  // Drag it: it moves, with no editor opened and nothing left selected.
  const before = (await firstBox(page)).points;
  await send(cdp, 'touchStart', [tp(x + 10, y, PEN, 1)]);
  for (let i = 1; i <= 6; i++) await send(cdp, 'touchMove', [tp(x + 10 + i * 20, y, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect.poll(async () => (await firstBox(page)).points[0]).toBeGreaterThan(before[0] + 50);
  await expect(page.locator('textarea.text-editor')).toHaveCount(0);
  await expect(page.locator('.select-bar')).toHaveCount(0);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await firstBox(page)).points[0]).toBe(before[0]);

  // A tap opens it for editing.
  await tap(cdp, x + 10, y);
  await expect(page.locator('textarea.text-editor')).toHaveValue('Move me');
});

test('while typing, the frame around the box shows the move cursor and drags the box without leaving the text', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 150, stripY(geo, 0));
  await page.keyboard.type('Draft');
  const editor = page.locator('textarea.text-editor');
  const frame = page.locator('.text-frame');
  await expect(frame).toHaveCSS('cursor', 'move');
  const fb = (await frame.boundingBox())!;
  const eb = (await editor.boundingBox())!;
  // Press the band above the text and drag right and down.
  const sx = eb.x + eb.width / 2, sy = fb.y + 3;
  await send(cdp, 'touchStart', [tp(sx, sy, PEN, 1)]);
  for (let i = 1; i <= 6; i++) await send(cdp, 'touchMove', [tp(sx + i * 15, sy + i * 5, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect.poll(async () => (await editor.boundingBox())!.x).toBeGreaterThan(eb.x + 60);
  // Still typing in the same box.
  await expect(editor).toBeFocused();
  await page.keyboard.type(' moved');
  await page.keyboard.press('Escape');
  const box = await firstBox(page);
  expect(box.text).toBe('Draft moved');
});

test('with the Select tool, the selection shows the move cursor and its corner the resize cursor', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.keyboard.press('t');
  await tap(cdp, geo.areaX + 150, stripY(geo, 0));
  await page.keyboard.type('Pick me');
  await page.keyboard.press('Escape');
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 120, y - 30, PEN, 1)]);
  for (let i = 1; i <= 6; i++) await send(cdp, 'touchMove', [tp(geo.areaX + 120 + i * 40, y + 25, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expect(page.locator('.select-bar')).toBeVisible();
  const live = page.locator('.canvas-area canvas.live');
  await page.mouse.move(geo.areaX + 170, y);
  await expect(live).toHaveCSS('cursor', 'move');
  await page.mouse.move(geo.areaX + 600, y + 200);
  await expect(live).toHaveCSS('cursor', 'crosshair');
});
