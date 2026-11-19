import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PEN, drag, expectStrokes, send, setup, stripY, tp } from './helpers';
import { USER_ID, mockSupabase } from './mockSupabase';

/** Your data: download a copy of everything, delete the account (or this device's notes). */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

/** Read a zip made of stored (uncompressed) entries: name -> bytes. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extra;
    out.set(name, buf.subarray(start, start + size));
    i = start + size;
  }
  return out;
}

async function openAccountSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Account' }).click();
}

async function download(page: Page) {
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  const d = await wait;
  expect(d.suggestedFilename()).toMatch(/^lineboard-data-\d{4}-\d{2}-\d{2}\.zip$/);
  return unzip(readFileSync((await d.path())!));
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.canvas-area canvas.live').waitFor();
}

test('without an account, "Download my data" gives a zip with every note, stroke, text box and picture', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.locator('.title-input').fill('Lecture 1');
  await page.locator('.title-input').press('Enter');
  const y = geo.areaY + 60;
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  await page.keyboard.press('t');
  await send(cdp, 'touchStart', [tp(geo.areaX + 400, y, PEN, 3)]);
  await send(cdp, 'touchEnd', []);
  await page.keyboard.type('Remember this');
  await page.keyboard.press('Escape');
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expectStrokes(page, 3);

  await openAccountSettings(page);
  const files = await download(page);
  expect([...files.keys()].sort()).toEqual(expect.arrayContaining(['README.txt', 'lineboard-data.json']));
  const data = JSON.parse(files.get('lineboard-data.json')!.toString('utf8'));
  expect(data).toMatchObject({ format: 'lineboard-export', version: 1, account: { local: true } });
  const note = data.notebooks.flatMap((b: { notes: unknown[] }) => b.notes).find((n: { title: string }) => n.title === 'Lecture 1');
  expect(note.strokes.map((s: { tool: string }) => s.tool).sort()).toEqual(['image', 'pen', 'text']);
  expect(note.strokes.find((s: { tool: string }) => s.tool === 'text').text).toBe('Remember this');
  const pic = note.strokes.find((s: { tool: string }) => s.tool === 'image');
  const file = files.get(`pictures/${pic.text}.png`)!;
  expect(file.subarray(1, 4).toString()).toBe('PNG');
  expect(data.settings.penColor).toBeTruthy();
});

test('without an account, "Delete everything on this device" removes the notes after confirming', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, geo.areaY + 60, geo.areaX + 300, geo.areaY + 60);
  await expectStrokes(page, 1);
  await openAccountSettings(page);
  await page.getByRole('button', { name: 'Delete everything on this device' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything', exact: true }).click();
  await page.locator('.canvas-area canvas.live').waitFor();
  await expectStrokes(page, 0);
});

test('with an account: download my data, then delete the account and everything in it', async ({ page }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const { attachBoard } = await import('./helpers');
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(() => db.strokes.length).toBe(1);
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => db.strokes.map((s) => s.tool).sort(), { timeout: 15_000 }).toEqual(['image', 'pen']);
  await expect.poll(() => db.images?.size ?? 0).toBe(1);

  await openAccountSettings(page);
  const files = await download(page);
  const data = JSON.parse(files.get('lineboard-data.json')!.toString('utf8'));
  expect(data.account).toEqual({ id: USER_ID, email: 'friend@example.com' });
  expect([...files.keys()].some((k) => k.startsWith('pictures/'))).toBe(true);

  // A wrong confirmation word deletes nothing.
  await page.getByRole('button', { name: 'Delete account' }).click();
  let dlg = page.locator('dialog.modal.small[open]');
  await expect(dlg).toContainText('cannot be undone');
  await dlg.locator('input').fill('delete');
  await dlg.getByRole('button', { name: 'Delete account' }).click();
  await expect(page.locator('#toast')).toContainText('Type DELETE');
  expect(db.deleted).toBeFalsy();

  // DELETE, then the password: the account and every file go.
  await page.getByRole('button', { name: 'Delete account' }).click();
  dlg = page.locator('dialog.modal.small[open]');
  await dlg.locator('input').fill('DELETE');
  await dlg.getByRole('button', { name: 'Delete account' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('#toast')).toContainText('deleted');
  expect(db.deleted).toBe(true);
  expect(db.strokes).toEqual([]);
  expect(db.notes).toEqual([]);
  expect(db.images?.size).toBe(0);
  // Nothing of the account is left on this device, and it cannot sign in again.
  const left = await page.evaluate((uid) => Object.keys(localStorage).filter((k) => k.includes(uid)), USER_ID);
  expect(left).toEqual([]);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.auth-msg')).toContainText('Invalid login credentials');
});

test('while a note is still loading the board takes no ink, so nothing drawn is silently lost', async ({ page }) => {
  const db = await mockSupabase(page);
  // Hold the note's strokes back for a moment.
  await page.route('**/rest/v1/strokes?*', async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes('note_id=')) await new Promise((r) => setTimeout(r, 1500));
    return route.fallback();
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const area = page.locator('.canvas-area');
  await expect(area).toHaveAttribute('aria-busy', 'true');
  const cdp = await page.context().newCDPSession(page);
  const b = (await area.boundingBox())!;
  await drag(cdp, b.x + 100, b.y + 30, b.x + 300, b.y + 30); // during loading: ignored
  await expect(area).not.toHaveAttribute('aria-busy');
  await page.waitForTimeout(500);
  expect(db.strokes.length).toBe(0);
  await drag(cdp, b.x + 100, b.y + 30, b.x + 300, b.y + 30); // once loaded: drawn and saved
  await expect.poll(() => db.strokes.length).toBe(1);
});

test.describe('first visit', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a one-time notice says what is stored (essential only, no tracking) and links to the details', async ({ page }) => {
    await page.goto('/home');
    const notice = page.getByRole('region', { name: 'Storage notice' });
    await expect(notice).toContainText('No ads, no analytics, no tracking cookies');
    await notice.getByRole('link', { name: 'What is stored' }).click();
    await expect(page).toHaveURL(/\/privacy#storage$/);
    await expect(page.locator('#storage h2')).toHaveText('Cookies and browser storage');
    await page.getByRole('region', { name: 'Storage notice' }).getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('region', { name: 'Storage notice' })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.policy-page h1')).toHaveText('Privacy policy');
    await expect(page.getByRole('region', { name: 'Storage notice' })).toHaveCount(0); // remembered
  });
});

test('the privacy policy covers rights, retention, providers and children; the terms cover acceptable use', async ({ page }) => {
  await page.goto('/privacy');
  for (const id of ['controller', 'data', 'purposes', 'storage', 'processors', 'retention', 'rights', 'security', 'children', 'contact']) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.locator('#rights')).toContainText('Download my data');
  await expect(page.locator('#rights')).toContainText('Delete account');
  await page.goto('/terms');
  for (const id of ['acceptable-use', 'limits', 'suspension', 'account']) await expect(page.locator(`section#${id}`)).toBeVisible();
});
