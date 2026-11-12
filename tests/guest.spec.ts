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
  await page.reload();
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
  await page.reload();
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
