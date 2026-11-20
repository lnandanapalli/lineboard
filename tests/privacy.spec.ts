import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { PEN, drag, expectStrokes, send, setup, stripY, tp } from './helpers';
import { USER_ID, mockSupabase } from './mockSupabase';

/** Your data: download a copy of everything, delete the account (or this device's notes). */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

/** Read a zip (stored or deflated entries, as Lineboard writes them): name -> bytes. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const packed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extra;
    const raw = buf.subarray(start, start + packed);
    out.set(name, method === 8 ? inflateRawSync(raw) : raw);
    i = start + packed;
  }
  return out;
}

type LbdNote = { title: string; strokes: { tool: string; text?: string; picture?: string; color?: string }[] };
/** A "Download my data" zip: account.json, and notes.lbd unpacked into its notes. */
function readExport(files: Map<string, Buffer>) {
  const account = JSON.parse(files.get('account.json')!.toString('utf8'));
  const lbd = unzip(files.get('notes.lbd')!);
  const manifest = JSON.parse(lbd.get('lineboard.json')!.toString('utf8'));
  const notes: LbdNote[] = manifest.notebooks.flatMap((b: { notes: { file: string }[] }) => b.notes.map((r) => JSON.parse(lbd.get(r.file)!.toString('utf8'))));
  return { account, manifest, notes, lbd };
}

/** Settings > Data controls: download, export, import, delete. */
async function openAccountSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
}

/** Click "Download my data" (signed in: confirm with the password) and read the zip. */
async function download(page: Page, password?: string) {
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  if (password) {
    const ask = page.locator('dialog.confirm-dialog');
    await ask.locator('input[type=password]').fill(password);
    await ask.getByRole('button', { name: 'Confirm' }).click();
  }
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
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expectStrokes(page, 3);

  await openAccountSettings(page);
  const files = await download(page);
  expect([...files.keys()].sort()).toEqual(['README.txt', 'account.json', 'notes.lbd']);
  const { account, manifest, notes, lbd } = readExport(files);
  expect(account).toMatchObject({ format: 'lineboard-account', version: 1, account: { local: true } });
  expect(account.settings.penColor).toBeTruthy();
  expect(manifest).toMatchObject({ format: 'lineboard', version: 1 });
  const note = notes.find((n) => n.title === 'Lecture 1')!;
  expect(note.strokes.map((s) => s.tool).sort()).toEqual(['image', 'pen', 'text']);
  expect(note.strokes.find((s) => s.tool === 'text')!.text).toBe('Remember this');
  const pic = note.strokes.find((s) => s.tool === 'image')!;
  expect(lbd.get(pic.picture!)!.subarray(1, 4).toString()).toBe('PNG');
});

test('without an account, "Delete everything on this device" removes the notes and pictures after confirming', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, geo.areaY + 60, geo.areaX + 300, geo.areaY + 60);
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expectStrokes(page, 2);
  await openAccountSettings(page);
  await page.getByRole('button', { name: 'Delete everything on this device', exact: true }).click();
  // The app reloads once everything is deleted: wait for that page, not the old one still showing.
  const reloaded = page.waitForEvent('load');
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete everything', exact: true }).click();
  await reloaded;
  await page.locator('.canvas-area canvas.live').waitFor();
  await expectStrokes(page, 0);
  // The picture files went too (the deletion finished before the page reloaded).
  const pictures = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open('lineboard-local-images'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!db.objectStoreNames.contains('images')) return 0;
    return new Promise<number>((res) => { const c = db.transaction('images').objectStore('images').count(); c.onsuccess = () => res(c.result); });
  });
  expect(pictures).toBe(0);
});

test('with an account: download my data, then delete the account and everything in it', async ({ page }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const { attachBoard } = await import('./helpers');
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(() => db.strokes.length).toBe(1);
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => db.strokes.map((s) => s.tool).sort(), { timeout: 15_000 }).toEqual(['image', 'pen']);
  await expect.poll(() => db.images?.size ?? 0).toBe(1);

  await openAccountSettings(page);
  // Signed in, the download asks for the password first; cancelling downloads nothing.
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Download my data' }).click();
  const ask = page.locator('dialog.confirm-dialog');
  await expect(ask).toContainText('Downloading your data gives a copy of everything in your account.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);
  expect(downloads).toBe(0);
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  await ask.locator('input[type=password]').fill('secret123');
  await ask.getByRole('button', { name: 'Confirm' }).click();
  const files = unzip(readFileSync((await (await wait).path())!));
  const { account, lbd } = readExport(files);
  expect(account.account).toEqual({ id: USER_ID, email: 'friend@example.com' });
  expect([...lbd.keys()].some((k) => k.startsWith('pictures/'))).toBe(true);

  // A wrong confirmation word deletes nothing.
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  let dlg = page.locator('dialog.modal.small[open]');
  await expect(dlg).toContainText('cannot be undone');
  await dlg.locator('input').fill('delete');
  await dlg.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Type DELETE');
  expect(db.deleted).toBeFalsy();

  // DELETE, then the password: the account and every file go.
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  dlg = page.locator('dialog.modal.small[open]');
  await dlg.locator('input').fill('DELETE');
  await dlg.getByRole('button', { name: 'Delete account', exact: true }).click();
  // The password was confirmed for the download moments ago, so it is not asked again (the same
  // short window as other sensitive changes); after that window it would be.
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

  test('a new visitor starts in split mode, with the split explanation', async ({ page }) => {
    await page.goto('/app');
    await expect(page.locator('.mode-btn')).toHaveAttribute('aria-label', 'Mode: Split');
    await expect(page.locator('.hint')).toContainText('open half of the screen');
  });

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

test('the export includes changes still waiting to be saved', async ({ page }) => {
  await mockSupabase(page);
  // The server is unreachable for saves: the stroke stays queued.
  await page.route('**/rest/v1/strokes*', (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()));
  await signIn(page);
  const { attachBoard } = await import('./helpers');
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect(page.locator('.status')).toHaveText(/Saving|Offline/);
  await openAccountSettings(page);
  const { notes } = readExport(await download(page, 'secret123'));
  expect(notes.flatMap((n) => n.strokes)).toHaveLength(1);
});

test('an account with more than 1000 notes gets all of them (listed and exported)', async ({ page }) => {
  test.setTimeout(90_000);
  const db = await mockSupabase(page);
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  db.notebooks.push({ id: USER_ID, user_id: USER_ID, name: 'My Notebook', name_enc: null, created_at: new Date(t0).toISOString(), updated_at: new Date(t0).toISOString() });
  for (let i = 0; i < 1005; i++) {
    const at = new Date(t0 + i * 60_000).toISOString();
    db.notes.push({ id: crypto.randomUUID(), user_id: USER_ID, notebook_id: USER_ID, title: `Note ${i}`, title_enc: null, created_at: at, updated_at: at });
  }
  await signIn(page);
  await openAccountSettings(page);
  const titles = readExport(await download(page, 'secret123')).notes.map((n) => n.title);
  expect(titles).toHaveLength(1005);
  expect(titles).toContain('Note 0'); // the oldest, beyond the first page
});

test('deleting the account asks for the password, and cancelling it deletes nothing', async ({ page }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await openAccountSettings(page);
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  const dlg = page.locator('dialog.modal.small[open]');
  await dlg.locator('input').fill('DELETE');
  await dlg.getByRole('button', { name: 'Delete account', exact: true }).click();
  const ask = page.locator('dialog.confirm-dialog');
  await expect(ask).toContainText('Deleting your account is permanent.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);
  expect(db.deleted).toBeFalsy();
});
