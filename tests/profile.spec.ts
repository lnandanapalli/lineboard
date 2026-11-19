import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, setup } from './helpers';
import { mockSupabase, USER_ID } from './mockSupabase';
import { cleanName, initials } from '../src/profile';

/** Profile: a display name and picture, shown in the sidebar instead of the email. */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

const openSidebar = async (page: Page) => {
  if (!(await page.locator('.app.sidebar-open').count())) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.waitForTimeout(300);
  }
};
const chip = (page: Page) => page.locator('.account-chip');

async function openProfile(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Account' }).click();
}

test('no name yet: a neutral icon and "Add your name"; a saved name shows as initials and survives a reload', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await expect(chip(page)).toContainText('Add your name');
  await expect(chip(page).locator('.avatar-circle.blank svg')).toBeVisible();

  await page.locator('.scrim').click();
  await openProfile(page);
  await page.getByLabel('Display name').fill('  Lokeshwar   Reddy ');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.locator('#toast')).toContainText('Name saved');
  await expect(page.locator('.profile-edit .avatar-circle')).toHaveText('LR');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await expect(chip(page)).toContainText('Lokeshwar Reddy');
  await expect(chip(page).locator('.avatar-circle')).toHaveText('LR');

  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(chip(page).locator('.avatar-circle')).toHaveText('LR');
});

test('a profile picture replaces the initials until it is removed', async ({ page }) => {
  await setup(page);
  await openProfile(page);
  await page.getByLabel('Display name').fill('Ada Lovelace');
  await page.getByRole('button', { name: 'Save name' }).click();
  await page.locator('.profile-edit input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.profile-edit .avatar-circle img')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change picture' })).toBeVisible();
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await expect(chip(page).locator('img')).toBeVisible();
  // A non-picture file is refused with a reason.
  await page.locator('.scrim').click();
  await openProfile(page);
  await page.locator('.profile-edit input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('#toast')).toContainText('not a picture');
  await page.getByRole('button', { name: 'Remove picture' }).click();
  await expect(page.locator('.profile-edit .avatar-circle')).toHaveText('AL');
});

test('signed in: the account menu replaces the email; the name and picture are saved to the account and in "Download my data"', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  await openSidebar(page);
  await expect(page.locator('.sidebar')).not.toContainText('friend@example.com');
  // The name and picture open Settings at the profile directly (no menu, so no Sign out to hit by mistake).
  await chip(page).click();
  await expect(page.locator('.settings-modal')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByLabel('Display name').fill('Grace Hopper');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect.poll(() => db.meta?.display_name).toBe('Grace Hopper');
  await page.locator('.profile-edit input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => db.images?.has(`${USER_ID}/profile-picture`)).toBe(true);
  expect(db.meta?.picture).toBeTruthy();

  // Another session (a reload) shows the same profile.
  await page.locator('.settings-close').click();
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(chip(page)).toContainText('Grace Hopper');
  await expect(chip(page).locator('img')).toBeVisible();
});

test('initials and names: two letters from the first and last words, names cleaned and capped', () => {
  expect(initials('Lokeshwar Reddy')).toBe('LR');
  expect(initials('cher')).toBe('C');
  expect(initials('Jean Claude van Damme')).toBe('JD');
  expect(initials('')).toBe('');
  expect(initials('  ')).toBe('');
  expect(initials('Ölaf Ångström')).toBe('ÖÅ');
  expect(initials('😀 Smile')).toBe('😀S'); // a character outside the basic plane is kept whole
  expect(cleanName('  a\tb\u200bc  ')).toBe('a bc');
  expect(cleanName('x'.repeat(100))).toHaveLength(60);
  expect(Array.from(cleanName('😀'.repeat(100)))).toHaveLength(60);
  expect(cleanName(42)).toBe('');
});

test('settings explain themselves behind ⓘ buttons: a popup opens and closes, and the setting is untouched', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Page & writing' }).click();
  // No long explanations on the screen itself.
  await expect(page.locator('.settings-pane:not([hidden])')).not.toContainText('Steadies shaky lines');
  const before = await page.getByRole('slider', { name: 'Smoothing' }).inputValue();
  await page.getByRole('button', { name: 'About Smoothing' }).click();
  const tip = page.getByRole('dialog', { name: 'Smoothing' });
  await expect(tip).toContainText('Steadies shaky lines');
  await expect(tip).toBeInViewport();
  expect(await page.getByRole('slider', { name: 'Smoothing' }).inputValue()).toBe(before);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  await expect(page.locator('.settings-modal')).toBeVisible(); // Escape closed the popup, not Settings
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
  await page.getByRole('button', { name: 'About End-to-end encryption' }).click();
  await expect(page.getByRole('dialog', { name: 'End-to-end encryption' })).toContainText('cannot be recovered by anyone');
});

test('turning encryption on also encrypts a profile picture added before', async ({ page }) => {
  test.setTimeout(60_000);
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  await openProfile(page);
  await page.locator('.profile-edit input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => db.images?.has(`${USER_ID}/profile-picture`)).toBe(true);
  expect(db.images!.get(`${USER_ID}/profile-picture`)!.body.subarray(0, 4).toString()).not.toBe('LBE1');
  expect(db.images!.get(`${USER_ID}/profile-picture`)!.body.length).toBeGreaterThan(100);

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
  await expect(dlg).toContainText('Your notes are encrypted', { timeout: 20_000 });
  // Only ciphertext is stored now ("LBE1" marks an encrypted file).
  expect(db.images!.get(`${USER_ID}/profile-picture`)!.body.subarray(0, 4).toString()).toBe('LBE1');
});
