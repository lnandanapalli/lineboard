import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, stripY } from './helpers';
import { MOCK_URL, mockSupabase } from './mockSupabase';

/** Abuse protection: the bot check at sign-in, and fair-use limits shown instead of silently dropped. */

async function fillSignIn(page: Page, password = 'secret123') {
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('with the bot check on, sign-in and "Confirm it\'s you" send a fresh token every time', async ({ page }) => {
  const db = await mockSupabase(page, undefined, { captcha: true });
  await page.goto('/login');
  // A wrong password uses up one token; the retry gets a new one and succeeds.
  await fillSignIn(page, 'wrong password');
  await expect(page.locator('.auth-msg')).toContainText('Invalid login credentials');
  await fillSignIn(page);
  await attachBoard(page);
  expect(db.captchaTokens).toHaveLength(2);
  expect(new Set(db.captchaTokens).size).toBe(2);

  // The password check behind "Confirm it's you" carries a token too.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('dialog.enc-wizard')).toContainText('Turn on end-to-end encryption?');
  expect(db.captchaTokens).toHaveLength(3);
});

test('with the bot check off, nothing is loaded from Cloudflare', async ({ page }) => {
  const hosts: string[] = [];
  page.on('request', (r) => hosts.push(new URL(r.url()).host));
  await mockSupabase(page);
  await page.goto('/login');
  await fillSignIn(page);
  await attachBoard(page);
  expect(hosts.filter((h) => h.includes('cloudflare'))).toEqual([]);
});

test('a save refused by a fair-use limit is explained, not silently lost', async ({ page }) => {
  await mockSupabase(page);
  await page.route(`${MOCK_URL}/rest/v1/strokes*`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
          body: JSON.stringify({ code: '23514', message: 'Lineboard limit: an account can have at most 50000 strokes in one note; start a new note' }),
        })
      : route.fallback(),
  );
  await page.goto('/login');
  await fillSignIn(page);
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect(page.locator('#toast')).toContainText('Not saved: An account can have at most 50000 strokes in one note; start a new note.');
});

test('new passwords need at least 8 characters; signing in still takes an older, shorter one', async ({ page }) => {
  const db = await mockSupabase(page);
  let signups = 0;
  page.on('request', (r) => r.url().includes('/auth/v1/signup') && signups++);
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill('new@example.com');
  await page.getByLabel('Password', { exact: true }).fill('abc1234'); // 7 characters
  await page.getByRole('button', { name: 'Create account' }).click();
  expect(await page.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.tooShort)).toBe(true);
  await page.waitForTimeout(300);
  expect(signups).toBe(0);
  // An account whose password predates the rule can still sign in.
  db.password = 'old123';
  await page.goto('/login');
  await fillSignIn(page, 'old123');
  await attachBoard(page);
});

test('password fields have a show / hide eye, and go back to hidden once submitted', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/signup');
  const pass = page.getByLabel('Password', { exact: true });
  await pass.fill('my secret pass');
  await expect(pass).toHaveAttribute('type', 'password');
  const eye = page.getByRole('button', { name: 'Show password' });
  await eye.click();
  await expect(pass).toHaveAttribute('type', 'text');
  await expect(pass).toBeFocused(); // pressing the eye keeps typing in the field
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(pass).toHaveAttribute('type', 'password');
  // Shown, then the form is sent: hidden again.
  await page.getByRole('button', { name: 'Show password' }).click();
  await page.getByLabel('Email', { exact: true }).fill('new@example.com');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(pass).toHaveAttribute('type', 'password');
});

test('a password shown in a dialog hides again when its button is pressed', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/login');
  await fillSignIn(page);
  await attachBoard(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  const pass = confirm.locator('input.dlg-input').first();
  await pass.fill('not my password');
  await confirm.getByRole('button', { name: 'Show password' }).click();
  await expect(pass).toHaveAttribute('type', 'text');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(confirm.locator('.enc-error')).toContainText('not right'); // still open after a failed check
  await expect(pass).toHaveAttribute('type', 'password');
});
