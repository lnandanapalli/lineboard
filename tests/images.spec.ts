import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { PEN, drag, expectStrokes, send, setup, tp } from './helpers';
import { USER_ID, mockSupabase, type MockDb } from './mockSupabase';

/** Pictures: insert (button, paste), draw on them, select to move / resize; stored per account. */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

type S = { id: string; tool: string; text?: string; points: number[] };
const strokes = (page: Page) =>
  page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('lb-local-strokes-'));
    return k ? (JSON.parse(localStorage[k]) as S[]) : [];
  });

async function freeBoard(page: Page) {
  const { cdp } = await setup(page);
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Free whiteboard/ }).click();
  await page.waitForTimeout(150);
  return { cdp, b: (await page.locator('.canvas-area').boundingBox())! };
}

async function insertPicture(page: Page) {
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
}

/** Screen position of a page point. */
const screen = (b: { x: number; y: number; width: number }, x: number, y: number) => ({ x: b.x + (x * b.width) / 1000, y: b.y + (y * b.width) / 1000 });

test('insert a picture, draw on it, move and resize it; the eraser leaves it alone', async ({ page }) => {
  const { cdp, b } = await freeBoard(page);
  await insertPicture(page);
  await expectStrokes(page, 1);
  let img = (await strokes(page))[0];
  expect(img.tool).toBe('image');
  await expect(page.locator('.select-tool')).toHaveClass(/active/); // selected, ready to move
  await expect(page.locator('.select-bar')).toBeVisible();

  // Draw across the picture with the pen: ink goes on top of it.
  await page.keyboard.press('p');
  const [l, t, , r, bt] = img.points;
  const mid = screen(b, (l + r) / 2, (t + bt) / 2);
  await drag(cdp, mid.x - 30, mid.y, mid.x + 30, mid.y);
  await expectStrokes(page, 2);

  // The eraser removes the ink, not the picture.
  await page.keyboard.press('e');
  await send(cdp, 'touchStart', [tp(mid.x - 25, mid.y, PEN, 1)]);
  for (let i = 1; i <= 10; i++) await send(cdp, 'touchMove', [tp(mid.x - 25 + i * 5, mid.y, PEN, 1)]);
  await send(cdp, 'touchEnd', []);
  await expectStrokes(page, 1);
  expect((await strokes(page))[0].tool).toBe('image');

  // Select it with a box that only touches a corner, then drag it.
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  const corner = screen(b, l, t);
  await drag(cdp, corner.x - 40, corner.y - 40, corner.x + 8, corner.y + 8);
  await expect(page.locator('.select-bar')).toBeVisible();
  await drag(cdp, mid.x, mid.y, mid.x + 100, mid.y + 60);
  await expect.poll(async () => (await strokes(page))[0].points[0]).toBeGreaterThan(l + 50);
  img = (await strokes(page))[0];

  // Resize from the corner handle: proportions are kept.
  const w0 = img.points[3] - img.points[0], h0 = img.points[4] - img.points[1];
  const handle = screen(b, img.points[3], img.points[4]);
  await drag(cdp, handle.x, handle.y, handle.x + 120, handle.y + 90);
  await expect.poll(async () => { const p = (await strokes(page))[0].points; return p[3] - p[0]; }).toBeGreaterThan(w0 * 1.3);
  const p = (await strokes(page))[0].points;
  expect(Math.abs((p[3] - p[0]) / (p[4] - p[1]) - w0 / h0)).toBeLessThan(0.02);

  // Delete it; undo brings it back; it survives a reload (stored on this device).
  await page.keyboard.press('Delete');
  await expectStrokes(page, 0);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectStrokes(page, 1);
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  const stored = await page.evaluate(async (id) => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('lineboard-local-images'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const blob: Blob | undefined = await new Promise((res) => { const g = db.transaction('images').objectStore('images').get(id); g.onsuccess = () => res(g.result); });
    return blob?.size ?? 0;
  }, (await strokes(page))[0].text!);
  expect(stored).toBeGreaterThan(50);
});

test('a pasted picture is added', async ({ page }) => {
  await freeBoard(page);
  await page.evaluate(async (bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [...PNG]);
  await expectStrokes(page, 1);
  expect((await strokes(page))[0].tool).toBe('image');
});

test('lasso and box select anything they touch, not only what is mostly inside', async ({ page }) => {
  const { cdp, b } = await freeBoard(page);
  const y = b.y + 200;
  await drag(cdp, b.x + 100, y, b.x + 500, y); // long line
  await page.keyboard.press('v');
  // A small loop around just the line's right end.
  await send(cdp, 'touchStart', [tp(b.x + 520, y, PEN, 4)]);
  for (let i = 1; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; await send(cdp, 'touchMove', [tp(b.x + 480 + 40 * Math.cos(a), y + 30 * Math.sin(a), PEN, 4)]); }
  await send(cdp, 'touchEnd', []);
  await expect(page.locator('.select-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  // A box crossing the middle of the line, with no line points inside its corners... still selects.
  await page.locator('.select-btn').click();
  await page.getByRole('menuitemradio', { name: /^Rectangle select/ }).click();
  await drag(cdp, b.x + 290, y - 30, b.x + 310, y + 30);
  await expect(page.locator('.select-bar')).toBeVisible();
});

// ---------------- with an account ----------------

async function signIn(page: Page, waitForBoard = true) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (waitForBoard) await page.locator('.canvas-area canvas.live').waitFor();
}

async function turnOnEncryption(page: Page, expectDone = 'Your notes are encrypted') {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  const dlg = page.locator('dialog.enc-wizard');
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await dlg.locator('input[type=password]').nth(0).fill('correct horse battery');
  await dlg.locator('input[type=password]').nth(1).fill('correct horse battery');
  await dlg.getByRole('button', { name: 'Create keys' }).click();
  const key = (await dlg.locator('.recovery-key').textContent())!;
  await dlg.getByLabel('Last 4 characters of the recovery key').fill(key.slice(-4));
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await expect(dlg).toContainText(expectDone, { timeout: 20_000 });
  await dlg.getByRole('button', { name: expectDone === 'Your notes are encrypted' ? 'Done' : /Close|Done|OK/ }).first().click();
  await page.locator('.settings-close').click();
}

async function otherDevice(browser: Browser, db: MockDb) {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173', viewport: { width: 800, height: 1280 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  await mockSupabase(page, db);
  return page;
}

test('pictures upload to the account; with encryption only ciphertext is stored, and another device can open them', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const db = await mockSupabase(page);
  await signIn(page);
  await insertPicture(page);
  await expect.poll(() => db.images?.size ?? 0).toBe(1);
  const [plainKey, plain] = [...db.images!.entries()][0];
  expect(plainKey.startsWith(USER_ID + '/')).toBe(true);
  expect(plain.body.subarray(1, 4).toString()).toBe('PNG');

  await expect.poll(() => db.strokes.length).toBe(1); // its stroke is saved too
  // Turning encryption on re-uploads it encrypted.
  await turnOnEncryption(page);
  await expect.poll(() => db.images!.get(plainKey)!.body.subarray(0, 4).toString()).toBe('LBE1');

  // A new picture is encrypted from the start.
  await insertPicture(page);
  await expect.poll(() => db.images!.size).toBe(2);
  for (const f of db.images!.values()) expect(f.body.subarray(0, 4).toString()).toBe('LBE1');

  // Another device unlocks and decrypts it.
  const tablet = await otherDevice(browser, db);
  await signIn(tablet, false);
  await tablet.getByLabel('Encryption passphrase').fill('correct horse battery');
  await tablet.getByRole('button', { name: 'Unlock' }).click();
  await tablet.locator('.canvas-area canvas.live').waitFor();
  // The picture is drawn from the decrypted file: sample the board where it is.
  const st = db.strokes.find((r) => !!r.enc)!; // encrypted rows: find the picture by asking the page
  expect(st).toBeTruthy();
  await expect
    .poll(
      () =>
        tablet.evaluate(() => {
          // Any pixel of the red/blue test picture on the ink canvas means it loaded and decrypted.
          const c = document.querySelectorAll<HTMLCanvasElement>('.canvas-area canvas')[1];
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 16) {
            const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
            if (a > 200 && ((r > 180 && g < 80 && b < 80) || (b > 180 && r < 80))) return true;
          }
          return false;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
});

test('a picture that cannot be downloaded while turning encryption on is retried later, not skipped', async ({ page }) => {
  test.setTimeout(60_000);
  const db = await mockSupabase(page);
  await signIn(page);
  await insertPicture(page);
  await expect.poll(() => db.strokes.length).toBe(1);
  const key = [...db.images!.keys()][0];
  // The storage server fails the first download.
  let failed = false;
  await page.route('**/storage/v1/object/images/**', (route) => {
    if (!failed && route.request().method() === 'GET') {
      failed = true;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: '500', error: 'internal', message: 'Storage is down' }) });
    }
    return route.fallback();
  });
  await turnOnEncryption(page, 'Encryption is not finished yet');
  expect(db.images!.get(key)!.body.subarray(1, 4).toString()).toBe('PNG');
  expect(db.strokes[0].enc).toBeFalsy(); // still marked as needing conversion
  // Opening the app again finishes the job.
  await page.reload();
  await expect.poll(() => db.images!.get(key)!.body.subarray(0, 4).toString(), { timeout: 15_000 }).toBe('LBE1');
  await expect.poll(() => !!db.strokes[0].enc).toBe(true);
});

test('a device that has not noticed encryption was turned on elsewhere does not upload a plaintext picture', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const db = await mockSupabase(page);
  await signIn(page);
  const other = await otherDevice(browser, db);
  await signIn(other);
  await turnOnEncryption(other);
  await insertPicture(page);
  // This device learns that encryption is on and asks to unlock instead of sending the file.
  await expect(page.getByRole('heading', { name: 'Your notes are encrypted.' })).toBeVisible({ timeout: 15_000 });
  for (const f of db.images?.values() ?? []) expect(f.body.subarray(0, 4).toString()).toBe('LBE1');
});
