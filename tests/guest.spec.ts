import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, expectStrokes, setup, stripY } from './helpers';
import { mockSupabase, USER_ID } from './mockSupabase';

/**
 * "Try it without an account" and moving those notes into an account on sign-in.
 * Runs against an in-memory Supabase stand-in (tests/mockSupabase.ts).
 */

async function tryWithoutAccount(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try it without an account' }).click();
  return attachBoard(page);
}

async function writeTwoStrokes(page: Page) {
  const { cdp, geo } = await attachBoard(page);
  const y = stripY(geo, 0);
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  await drag(cdp, geo.areaX + 400, y, geo.areaX + 600, y);
  await expectStrokes(page, 2);
}

async function signIn(page: Page) {
  await page.getByPlaceholder('Email').fill('friend@example.com');
  await page.getByPlaceholder('Password').fill('secret123');
  await page.locator('form.auth-form button[type=submit]').click();
}

const localNoteCount = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]').length);

test('a new visitor can try without an account, and a reload keeps them there', async ({ page }) => {
  await mockSupabase(page);
  await tryWithoutAccount(page);
  await writeTwoStrokes(page);
  await expect(page.locator('.toolbar .signin-save')).toBeVisible();

  await page.reload();
  await attachBoard(page);
  await expectStrokes(page, 2);
  await expect(page.locator('form.auth-form')).toHaveCount(0);
});

test('signing in from guest mode moves the notes into the account', async ({ page }) => {
  const db = await mockSupabase(page);
  await tryWithoutAccount(page);
  await page.locator('.title-input').fill('Physics notes');
  await page.locator('.title-input').press('Enter');
  await writeTwoStrokes(page);

  await page.locator('.toolbar .signin-save').click();
  await expect(page.locator('.guest-box p')).toContainText('the note you made on this device');
  await signIn(page);

  await attachBoard(page);
  await expect(page.locator('.title-input')).toHaveValue('Physics notes');
  expect(db.notes.map((n) => n.title)).toContain('Physics notes');
  expect(db.strokes).toHaveLength(2);
  expect(db.strokes.every((s) => s.user_id === USER_ID)).toBe(true);
  expect(await localNoteCount(page)).toBe(0); // browser copy cleared
  await expect(page.locator('.signin-save')).toHaveCount(0);
});

test('guest sign-in keeps recoverable trash on this device', async ({ page }) => {
  const db = await mockSupabase(page);
  await tryWithoutAccount(page);
  await writeTwoStrokes(page);
  const ids = await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('lb-local-notes')!);
    const books = JSON.parse(localStorage.getItem('lb-local-notebooks')!);
    const now = new Date().toISOString();
    const notebook = { id: crypto.randomUUID(), name: 'Trashed notebook', created_at: now, updated_at: now, deleted_at: now };
    books.push({ ...notebook, id: 'trash', name: 'Trash', deleted_at: null }, notebook);
    const originalStrokes = JSON.parse(localStorage.getItem('lb-local-strokes-' + notes[0].id)!);
    const trashed = ['trash', notebook.id].map((notebook_id) => ({ ...notes[0], id: crypto.randomUUID(), notebook_id, deleted_at: now }));
    for (const note of trashed) localStorage.setItem('lb-local-strokes-' + note.id, JSON.stringify(originalStrokes.map((s: object) => ({ ...s, id: crypto.randomUUID(), note_id: note.id }))));
    localStorage.setItem('lb-local-notebooks', JSON.stringify(books));
    localStorage.setItem('lb-local-notes', JSON.stringify([...notes, ...trashed]));
    return trashed.map((note) => note.id);
  });

  await page.locator('.toolbar .signin-save').click();
  await signIn(page);
  await attachBoard(page);
  await expect.poll(() => localNoteCount(page)).toBe(2);
  expect(db.strokes).toHaveLength(2);
  expect(await page.evaluate((noteIds) => noteIds.map((id) => JSON.parse(localStorage.getItem('lb-local-strokes-' + id) ?? '[]').length), ids)).toEqual([2, 2]);
});

test('guest sign-in waits for handwriting that could not be saved locally', async ({ page }) => {
  const db = await mockSupabase(page);
  const { cdp, geo } = await tryWithoutAccount(page);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    (window as unknown as { allowSaves: () => void }).allowSaves = () => { Storage.prototype.setItem = setItem; window.dispatchEvent(new Event('online')); };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('lb-local-strokes-')) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect(page.locator('.status')).toHaveText('Not saved yet, will retry');
  await page.locator('.toolbar .signin-save').click();
  await expect(page.locator('#toast')).toContainText('Your changes are still waiting to save');
  await expect(page).toHaveURL(/\/app$/);
  await page.evaluate(() => (window as unknown as { allowSaves: () => void }).allowSaves());
  await expect(page.locator('.status')).toHaveText('Saved on device');
  await page.locator('.toolbar .signin-save').click();
  await signIn(page);
  await attachBoard(page);
  expect(db.strokes).toHaveLength(1);
});

test('"Back to my notes" returns to guest mode with nothing lost', async ({ page }) => {
  const db = await mockSupabase(page);
  await tryWithoutAccount(page);
  await writeTwoStrokes(page);

  await page.locator('.toolbar .signin-save').click();
  await page.getByRole('button', { name: 'Back to my notes without signing in' }).click();
  await attachBoard(page);
  await expectStrokes(page, 2);
  expect(db.strokes).toHaveLength(0);
});

test('a normal sign-in asks before adding guest notes; "keep separate" leaves them', async ({ page }) => {
  const db = await mockSupabase(page);
  await tryWithoutAccount(page);
  await writeTwoStrokes(page);
  // Leave guest mode the way a returning visitor would: back on the plain sign-in screen.
  await page.evaluate(() => localStorage.removeItem('lb-guest-active'));
  await page.goto('/login');
  await signIn(page);

  await page.getByRole('button', { name: 'Keep them separate on this device' }).click();
  await attachBoard(page);
  expect(db.strokes).toHaveLength(0);
  expect(await localNoteCount(page)).toBe(1);
});

test('a normal sign-in can add guest notes when the user agrees', async ({ page }) => {
  const db = await mockSupabase(page);
  await tryWithoutAccount(page);
  await writeTwoStrokes(page);
  await page.evaluate(() => localStorage.removeItem('lb-guest-active'));
  await page.goto('/login');
  await signIn(page);

  await page.getByRole('button', { name: 'Add it to my account' }).click();
  await attachBoard(page);
  await expect.poll(() => db.strokes.length).toBe(2);
  expect(await localNoteCount(page)).toBe(0);
});

test('self-hosted local mode (no Supabase) has no sign-in prompts', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.signin-save')).toHaveCount(0);
  await expect(page.locator('form.auth-form')).toHaveCount(0);
});
