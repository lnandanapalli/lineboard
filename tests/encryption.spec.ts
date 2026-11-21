import { expect, test, type Browser, type Page } from '@playwright/test';
import { TEST_STORAGE } from './storageState';
import { attachBoard, drag, stripY } from './helpers';
import { mockSupabase, type MockDb } from './mockSupabase';

/** Optional end-to-end encryption: turning it on, unlocking on another device, recovery, turning it off. */

const PASS = 'correct horse battery';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A second device: a fresh browser context sharing the same mock database. */
async function otherDevice(browser: Browser, db: MockDb) {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173', viewport: { width: 800, height: 1280 }, hasTouch: true, serviceWorkers: 'block', storageState: TEST_STORAGE });
  const page = await context.newPage();
  await mockSupabase(page, db);
  return page;
}

async function openSecurity(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
}

/** Turn encryption on through the wizard and return the recovery key it showed. */
async function enableEncryption(page: Page): Promise<string> {
  await openSecurity(page);
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  // Turning encryption on asks for the account password first.
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  const dlg = page.locator('dialog.enc-wizard');
  await expect(dlg).toContainText('Turn on end-to-end encryption?');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('Tick the box');
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();

  const [a, b] = [dlg.locator('input[type=password]').nth(0), dlg.locator('input[type=password]').nth(1)];
  await a.fill('short');
  await b.fill('short');
  await dlg.getByRole('button', { name: 'Create keys' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('at least 10');
  await a.fill(PASS);
  await b.fill(PASS);
  await dlg.getByRole('button', { name: 'Create keys' }).click();

  const key = (await dlg.locator('.recovery-key').textContent())!;
  expect(key).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  await dlg.getByLabel('Last 4 characters of the recovery key').fill(key.slice(-4).toLowerCase());
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await expect(dlg).toContainText('Your notes are encrypted', { timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Done' }).click();
  return key;
}

test('turning on encryption encrypts existing notes, and another device must unlock them', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const { cdp, geo } = await attachBoard(page);
  await expect(page.locator('.title-input')).not.toHaveValue(''); // the first note has opened
  await page.locator('.title-input').fill('Secret plans');
  await page.locator('.title-input').press('Enter');
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(() => db.strokes.length).toBe(1);
  await expect.poll(() => db.notes[0]?.title).toBe('Secret plans');

  const recoveryKey = await enableEncryption(page);
  await expect(page.getByRole('switch', { name: 'End-to-end encryption' })).toHaveAttribute('aria-checked', 'true');

  // The "server" now only holds ciphertext.
  expect(db.keys?.state).toBe('on');
  const dump = JSON.stringify({ notebooks: db.notebooks, notes: db.notes, strokes: db.strokes });
  expect(dump).not.toContain('Secret plans');
  expect(dump).not.toContain('My Notebook');
  expect(db.strokes[0]).toMatchObject({ points: null, color: null, tool: null });
  expect(String(db.strokes[0].enc)).toMatch(/^v1\./);
  expect(db.notes[0].title_enc).toBeTruthy();

  // New ink is encrypted too.
  await page.locator('.settings-close').click();
  await drag(cdp, geo.areaX + 100, stripY(geo, 0) + 20, geo.areaX + 300, stripY(geo, 0) + 20);
  await expect.poll(() => db.strokes.length).toBe(2);
  expect(db.strokes.every((s) => s.enc && s.points === null)).toBe(true);

  // This device remembers the key: a reload goes straight back to the note.
  await page.reload();
  await expect(page.locator('.title-input')).toHaveValue('Secret plans');

  // Another device has to unlock first, and a wrong passphrase is refused.
  const tablet = await otherDevice(browser, db);
  await signIn(tablet);
  await expect(tablet.getByRole('heading', { name: 'Your notes are encrypted.' })).toBeVisible();
  await tablet.getByLabel('Encryption passphrase').fill('not the passphrase');
  await tablet.getByRole('button', { name: 'Unlock' }).click();
  await expect(tablet.locator('.enc-error')).toContainText('not right', { timeout: 15_000 });
  await tablet.getByLabel('Encryption passphrase').fill(PASS);
  await tablet.getByRole('button', { name: 'Unlock' }).click();
  await expect(tablet.locator('.title-input')).toHaveValue('Secret plans', { timeout: 15_000 });

  // Forgot the passphrase on a third device: the recovery key unlocks and sets a new one.
  const phone = await otherDevice(browser, db);
  await signIn(phone);
  await phone.getByRole('button', { name: 'Forgot it? Use your recovery key' }).click();
  await phone.getByLabel('Recovery key').fill(recoveryKey.replace(/-/g, ' ').toLowerCase());
  await phone.getByLabel('New passphrase').fill('a brand new passphrase');
  await phone.getByLabel('Type it again').fill('a brand new passphrase');
  await phone.getByRole('button', { name: 'Unlock and set passphrase' }).click();
  await expect(phone.locator('.title-input')).toHaveValue('Secret plans', { timeout: 15_000 });

  // Turning it off (with the new passphrase) puts readable notes back on the server.
  await openSecurity(phone);
  await phone.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const off = phone.locator('dialog[open].modal.small');
  await off.locator('input[type=password]').fill('a brand new passphrase');
  await off.getByRole('button', { name: 'Turn off encryption' }).click();
  await expect(off).toContainText('Encryption is off', { timeout: 20_000 });
  expect(db.keys?.state).toBe('off');
  expect(db.notes[0].title).toBe('Secret plans');
  expect(db.notes[0].title_enc).toBeNull();
  expect(db.strokes.every((s) => !s.enc && Array.isArray(s.points))).toBe(true);
});

test('a device that lost both secrets can start over with an empty account', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await attachBoard(page);
  await enableEncryption(page);

  const other = await otherDevice(browser, db);
  await signIn(other);
  await other.getByRole('button', { name: 'Forgot it? Use your recovery key' }).click();
  await other.getByRole('button', { name: 'Lost both?' }).click();
  await other.getByRole('button', { name: 'Delete my notes and start over' }).click();
  await expect(other.locator('.enc-error')).toContainText('Type DELETE');
  await other.getByLabel('Type DELETE to confirm').fill('DELETE');
  await other.getByRole('button', { name: 'Delete my notes and start over' }).click();
  await expect(other.locator('.canvas-area canvas.live')).toBeVisible();
  expect(db.keys).toBeNull();
  // A fresh, readable default notebook.
  await expect.poll(() => db.notebooks.map((b) => b.name).sort()).toEqual(['My Notebook', 'Trash']);
});

test('settings are split into sections', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const tabs = page.locator('.settings-tab');
  await expect(tabs).toHaveText(['Account', 'Data controls', 'Sign-in & devices', 'Encryption', 'Page & writing', 'Stylus & palm', 'About']);
  await tabs.filter({ hasText: 'Stylus & palm' }).click();
  // Automatic palm detection by default; the fixed limit and calibration pad come with their own switch.
  const manual = page.getByRole('switch', { name: 'Set the palm limit myself' });
  await expect(manual).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.cal-pad')).toBeHidden();
  await manual.click();
  await expect(page.locator('.cal-pad')).toBeVisible();
  await expect(page.locator('.palm-manual-note')).toContainText('Automatic detection is off');
  await expect(page.locator('.settings-pane[data-section="account"]')).toBeHidden();
  await tabs.filter({ hasText: 'Encryption' }).click();
  await expect(page.getByRole('switch', { name: 'End-to-end encryption' })).toBeDisabled();
});

test('a device that is already open asks to unlock when another device turns encryption on, and keeps its ink', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const { cdp, geo } = await attachBoard(page);

  const other = await otherDevice(browser, db);
  await signIn(other);
  await attachBoard(other);
  await enableEncryption(other);

  // The first device still thinks encryption is off; the server refuses its plaintext ink.
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect(page.getByRole('heading', { name: 'Your notes are encrypted.' })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Encryption passphrase').fill(PASS);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => db.strokes.length, { timeout: 15_000 }).toBe(1);
  expect(db.strokes[0].enc).toBeTruthy();
});

/** Go through the wizard up to the recovery key, without saving the keys yet. */
async function upToRecoveryKey(page: Page, pass: string) {
  await openSecurity(page);
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  const dlg = page.locator('dialog.enc-wizard');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await dlg.locator('input[type=password]').nth(0).fill(pass);
  await dlg.locator('input[type=password]').nth(1).fill(pass);
  await dlg.getByRole('button', { name: 'Create keys' }).click();
  const key = (await dlg.locator('.recovery-key').textContent())!;
  await dlg.getByLabel('Last 4 characters of the recovery key').fill(key.slice(-4));
  await dlg.locator('input[type=checkbox]').check();
  return dlg;
}

test('two devices turning encryption on at once: the second never overwrites the first one’s keys', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(() => db.strokes.length).toBe(1);
  const other = await otherDevice(browser, db);
  await signIn(other);
  await attachBoard(other);

  // Both have made keys and shown their recovery key; the first saves its keys and encrypts.
  const first = await upToRecoveryKey(page, PASS);
  const second = await upToRecoveryKey(other, 'another long passphrase');
  await first.getByRole('button', { name: 'Continue' }).click();
  await expect(first).toContainText('Your notes are encrypted', { timeout: 20_000 });
  const keyId = db.keys!.key_id;
  expect(db.strokes[0].enc).toBeTruthy();

  // The second is refused, and says why; the first device's keys stay.
  await second.getByRole('button', { name: 'Continue' }).click();
  await expect(second).toContainText('Encryption was set up elsewhere');
  await expect(second).toContainText('set up on another device');
  expect(db.keys!.key_id).toBe(keyId);

  // The ink is still readable with the first device's passphrase.
  await second.getByRole('button', { name: 'Reload' }).click();
  const unlock = other.locator('.unlock-form, form').filter({ has: other.locator('input[type=password]') }).first();
  await unlock.locator('input[type=password]').fill(PASS);
  await unlock.getByRole('button', { name: /Unlock/ }).click();
  await attachBoard(other);
  await expect.poll(() => other.evaluate(() => document.querySelector('.canvas-area')?.getAttribute('data-note'))).toBeTruthy();
});

test('turning encryption on covers every note (past 1000) and pictures only version history points at', async ({ page }) => {
  test.setTimeout(180_000);
  const db = await mockSupabase(page);
  const { readFileSync } = await import('node:fs');
  const { USER_ID } = await import('./mockSupabase');
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  db.notebooks.push({ id: USER_ID, user_id: USER_ID, name: 'My Notebook', name_enc: null, created_at: new Date(t0).toISOString(), updated_at: new Date(t0).toISOString() });
  for (let i = 0; i < 1005; i++) {
    const at = new Date(t0 + i * 60_000).toISOString();
    db.notes.push({ id: crypto.randomUUID(), user_id: USER_ID, notebook_id: USER_ID, title: `Note ${i}`, title_enc: null, created_at: at, updated_at: at });
  }
  // A picture no stroke points at any more (only an old version does), stored in plaintext.
  const png = readFileSync('tests/fixture.png');
  db.images = new Map([[`${USER_ID}/history-only-picture`, { body: png, type: 'image/png' }]]);

  await signIn(page);
  await attachBoard(page);
  await enableEncryption(page);
  expect(db.keys!.state).toBe('on');
  const plainTitles = db.notes.filter((n) => !n.title_enc || n.title);
  expect(plainTitles).toHaveLength(0);
  const pic = db.images.get(`${USER_ID}/history-only-picture`)!;
  expect(pic.type).toBe('application/octet-stream');
  expect(pic.body.subarray(0, 8).equals(png.subarray(0, 8))).toBe(false);
});

test('signed out from another device: the key remembered on this device is forgotten too', async ({ page }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await attachBoard(page);
  await enableEncryption(page); // "Keep this device unlocked" is on
  const remembered = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('lineboard-keys', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('keys');
          req.onsuccess = () => {
            const c = req.result.transaction('keys').objectStore('keys').count();
            c.onsuccess = () => {
              req.result.close();
              resolve(c.result);
            };
          };
        }),
    );
  expect(await remembered()).toBe(1);
  // Another device signs this one out; it notices when it comes back into view.
  db.sessions = [];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(remembered).toBe(0);
});
