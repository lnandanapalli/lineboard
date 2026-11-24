import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, savedStrokes, setup, stripY } from './helpers';
import { mockSupabase } from './mockSupabase';

/** Data safety under pressure: full storage, other tabs, other devices, slow uploads. */

test('with the device’s storage full, ink is not reported saved, is kept, and is saved once there is room', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // The browser refuses to store more ink (the queue itself still fits).
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    (window as unknown as { __full: boolean }).__full = true;
    Storage.prototype.setItem = function (k: string, v: string) {
      if ((window as unknown as { __full: boolean }).__full && k.startsWith('lb-local-strokes-')) throw new DOMException('full', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await drag(cdp, geo.areaX + 50, stripY(geo, 0), geo.areaX + 200, stripY(geo, 0));
  await expect(page.locator('#toast')).toContainText('storage is full');
  await expect(page.locator('.status')).toHaveText('Not saved yet, will retry');
  expect(await savedStrokes(page)).toBe(0);
  // Still waiting, and kept for a reload.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-queue-local:')).length)).toBe(1);

  // Space is freed: the retry saves it.
  await page.evaluate(() => ((window as unknown as { __full: boolean }).__full = false));
  await expect.poll(() => savedStrokes(page), { timeout: 15_000 }).toBe(1);
  await expect(page.locator('.status')).toHaveText('Saved on device');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lb-queue-local:')).length)).toBe(0);
});

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

/** Picture files kept on this device. */
const localPictures = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('lineboard-local-images', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('images');
        req.onsuccess = () => {
          const keys = req.result.transaction('images').objectStore('images').getAllKeys();
          keys.onsuccess = () => {
            req.result.close();
            resolve((keys.result as string[]).filter((k) => k !== 'profile-picture'));
          };
        };
      }),
  );

async function copyNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'Version history' }).click();
  const panel = page.getByRole('complementary', { name: 'Version history' });
  await panel.getByRole('button', { name: 'Make a copy' }).click();
  await page.locator('dialog[open] .dlg-input').fill(title);
  await page.locator('dialog[open]').getByRole('button', { name: 'Make a copy' }).click();
  await expect(page.locator('.title-input')).toHaveValue(title);
}

async function deleteForever(page: Page, title: string) {
  const dlg = page.locator('dialog.modal.small[open]');
  if (!(await page.locator('.app.sidebar-open').count())) await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const row = page.locator('.note-list li', { has: page.locator('.note-title', { hasText: title }) });
  await row.first().locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await dlg.getByRole('button', { name: 'Move to trash' }).click();
  await page.locator('.trash-btn').click();
  await page.locator('.trash-list').getByRole('button', { name: `Delete "${title}" forever` }).click();
  await dlg.getByRole('button', { name: 'Delete forever' }).click();
  await page.locator('.settings-close').click();
}

test('deleting a note for good removes its pictures, unless another note (a copy) still uses them', async ({ page }) => {
  await setup(page);
  await page.locator('.title-input').fill('Original');
  await page.locator('.title-input').press('Enter');
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => localPictures(page)).toHaveLength(1);
  await copyNote(page, 'Copy'); // the copy uses the same picture file
  await deleteForever(page, 'Original');
  expect(await localPictures(page)).toHaveLength(1); // still used by the copy
  await deleteForever(page, 'Copy');
  await expect.poll(() => localPictures(page)).toHaveLength(0);
});

test('signed in: picture uses are recorded (older notes once, in the background), and deleting for good tidies files no note uses', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(db.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  // The account's older notes are gone over once, then marked done.
  await expect.poll(() => db.imageUsesComplete).toBe(true);
  await expect(page.locator('.title-input')).not.toHaveValue('');
  await page.locator('.title-input').fill('Original');
  await page.locator('.title-input').press('Enter');
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => db.images?.size ?? 0).toBe(1);
  await expect.poll(() => (db.imageUses ?? []).length).toBe(1);
  await page.locator('.toolbar input[type=file][accept^="image/"]').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => (db.imageUses ?? []).length).toBe(2);
  await copyNote(page, 'Copy');
  await expect.poll(() => (db.imageUses ?? []).length).toBe(4);
  const shared = [...db.imageUses!].sort((a, b) => a.image_id.localeCompare(b.image_id))[0];
  // The second picture's surviving reference is beyond the first page.
  const extraUses = Array.from({ length: 1000 }, () => ({ ...shared, note_id: crypto.randomUUID() }));
  db.imageUses!.unshift(...extraUses);
  const nextPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith('/note_images') && url.searchParams.getAll('image_id').includes('gt.' + shared.image_id);
  });
  await deleteForever(page, 'Original');
  await nextPage;
  await expect.poll(() => (db.imageUses ?? []).length).toBe(1002);
  expect(db.images!.size).toBe(2);
  db.imageUses = db.imageUses!.filter((use) => !extraUses.includes(use));
  await deleteForever(page, 'Copy');
  await expect.poll(() => db.images!.size).toBe(0);
});

test('signed in: until older notes’ picture uses are recorded, deleting removes no picture files', async ({ page }) => {
  const db = await mockSupabase(page);
  const { USER_ID } = await import('./mockSupabase');
  const now = new Date().toISOString();
  // An older account: a note using a picture, with no record of it yet, and a key that is not here.
  db.notebooks.push({ id: USER_ID, user_id: USER_ID, name: 'My Notebook', created_at: now, updated_at: now });
  db.notes.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', user_id: USER_ID, title: 'Old', notebook_id: USER_ID, created_at: now, updated_at: now });
  db.notes.push({ id: 'aaaaaaaa-0000-4000-8000-000000000002', user_id: USER_ID, title: 'Old copy', notebook_id: USER_ID, created_at: now, updated_at: now });
  for (const n of ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'])
    db.strokes.push({ id: crypto.randomUUID(), note_id: n, user_id: USER_ID, tool: 'image', color: 'image/png', width: 1, points: [0, 0, 0, 100, 100, 0], text: 'shared-pic', created_at: now });
  db.images = new Map([[`${USER_ID}/shared-pic`, { body: PNG, type: 'image/png' }]]);
  // Recording older uses fails for now (say, offline): nothing may be removed meanwhile.
  await page.route('**/rest/v1/note_images_state*', (route) => (route.request().method() === 'POST' ? route.abort() : route.fallback()));
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(db.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  await deleteForever(page, 'Old');
  await expect.poll(() => db.notes.map((n) => n.title)).not.toContain('Old');
  expect(db.images.size).toBe(1); // still there: "Old copy" uses it
  // Once older uses are recorded, the copy's use is known, and deleting it tidies the file.
  await page.unroute('**/rest/v1/note_images_state*');
  await page.reload();
  await attachBoard(page);
  await expect.poll(() => db.imageUsesComplete).toBe(true);
  await deleteForever(page, 'Old copy');
  await expect.poll(() => db.images!.size).toBe(0);
});
