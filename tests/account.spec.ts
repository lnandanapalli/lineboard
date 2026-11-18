import { expect, test, type Browser, type Page } from '@playwright/test';
import { MOCK_TOTP, mockSupabase, recoveryHash, type MockDb } from './mockSupabase';

/** Signed-in devices, password changes, two-step verification (authenticator app) and passkeys. */

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-X210) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function otherDevice(browser: Browser, db: MockDb, userAgent = ANDROID) {
  const context = await browser.newContext({ baseURL: 'http://localhost:4173', viewport: { width: 800, height: 1280 }, hasTouch: true, serviceWorkers: 'block', userAgent });
  const page = await context.newPage();
  await mockSupabase(page, db);
  return page;
}

async function openSignin(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Sign-in & devices' }).click();
}

const board = (page: Page) => page.locator('.canvas-area canvas.live');
/** Pretend the person came back to the tab, which makes the app re-check its session. */
const refocus = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('lists signed-in devices and signs one out, which returns it to the sign-in page', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await expect(board(page)).toBeVisible();
  const tablet = await otherDevice(browser, db);
  await signIn(tablet);
  await expect(board(tablet)).toBeVisible();

  await openSignin(page);
  const devices = page.locator('.set-card', { hasText: 'Signed-in devices' }).locator('.item-row');
  await expect(devices).toHaveCount(2);
  await expect(devices.filter({ hasText: 'This device' })).toHaveCount(1);
  const android = devices.filter({ hasText: 'Chrome on Android' });
  await android.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('dialog.modal.small[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(devices).toHaveCount(1);
  expect(db.sessions).toHaveLength(1);

  // The revoked device can no longer read notes, and notices it was signed out.
  await refocus(tablet);
  await expect(tablet.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(tablet).toHaveURL(/\/login$/);
  await expect(tablet.locator('.signin-save')).toHaveCount(0); // not dropped into guest mode
});

test('"sign out all other devices" keeps only this one', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  for (let i = 0; i < 2; i++) await signIn(await otherDevice(browser, db));
  await expect.poll(() => db.sessions.length).toBe(3);
  await expect(board(page)).toBeVisible();
  await openSignin(page);
  await page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await page.locator('dialog.modal.small[open]').getByRole('button', { name: 'Sign out others' }).click();
  await expect.poll(() => db.sessions.length).toBe(1);
  await expect(page.locator('.set-card', { hasText: 'Signed-in devices' }).locator('.item-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toBeDisabled();
});

test('changing the password signs out the other devices', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const tablet = await otherDevice(browser, db);
  await signIn(tablet);
  await expect(board(tablet)).toBeVisible();
  await expect(board(page)).toBeVisible();

  await openSignin(page);
  await page.getByRole('button', { name: 'Change password' }).click();
  const dlg = page.locator('dialog[open].modal.small');
  const [a, b] = [dlg.locator('input[type=password]').nth(0), dlg.locator('input[type=password]').nth(1)];
  await a.fill('new password 1');
  await b.fill('new password 2');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('do not match');
  await b.fill('new password 1');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg).toHaveCount(0);
  expect(db.passwordChanges).toBe(1);
  expect(db.sessions).toHaveLength(1);
  await refocus(tablet);
  await expect(tablet).toHaveURL(/\/login$/);
});

test('a password reset from the email link signs out every other device', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await expect(board(page)).toBeVisible();

  const phone = await otherDevice(browser, db);
  await phone.goto('/' + recoveryHash(db));
  await expect(phone.getByRole('button', { name: 'Set new password' })).toBeVisible();
  await expect(phone.getByLabel('Sign out all other devices')).toBeChecked();
  await phone.getByPlaceholder('New password').fill('a fresh password');
  await phone.getByRole('button', { name: 'Set new password' }).click();
  await expect(board(phone)).toBeVisible();
  expect(db.passwordChanges).toBe(1);
  expect(db.sessions).toHaveLength(1); // only the device that reset the password

  await refocus(page);
  await expect(page).toHaveURL(/\/login$/);
});

test('authenticator-app two-step verification: set up, required at sign-in, removable', async ({ page, browser }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  const tablet = await otherDevice(browser, db);
  await signIn(tablet);
  await expect(board(tablet)).toBeVisible();
  await expect(board(page)).toBeVisible();

  await openSignin(page);
  const mfa = page.locator('.set-card', { hasText: 'Two-step verification' });
  await expect(mfa.locator('.pill')).toHaveText('Off');
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const dlg = page.locator('dialog.mfa-dialog');
  await expect(dlg.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expect(dlg.locator('.mfa-secret')).toHaveText('JBSW Y3DP EHPK 3PXP');
  await dlg.getByLabel('6-digit code').fill('000000');
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('not right');
  await dlg.getByLabel('6-digit code').fill(MOCK_TOTP);
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await expect(dlg).toContainText('Two-step verification is on');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(mfa.locator('.pill')).toHaveText('On');
  expect(db.factors.filter((f) => f.status === 'verified')).toHaveLength(1);
  expect(db.sessions).toHaveLength(1); // turning it on signed the tablet out

  // Signing in again asks for a code before any notes load.
  await refocus(tablet);
  await expect(tablet).toHaveURL(/\/login$/);
  await signIn(tablet);
  await expect(tablet.getByRole('heading', { name: 'Two-step verification.' })).toBeVisible();
  await expect(board(tablet)).toHaveCount(0);
  await tablet.getByLabel('Code').fill('111111');
  await expect(tablet.locator('.enc-error')).toContainText('not right');
  await tablet.getByLabel('Code').fill(MOCK_TOTP); // submits by itself once 6 digits are in
  await expect(board(tablet)).toBeVisible();

  // Remove it again (needs the second step, which this session has).
  await mfa.getByRole('button', { name: 'Remove' }).click();
  await page.locator('dialog.modal.small[open]').getByRole('button', { name: 'Remove' }).click();
  await expect(mfa.locator('.pill')).toHaveText('Off');
  expect(db.factors).toHaveLength(0);
});

test('passkeys: add one in settings, then sign in with it', async ({ page }) => {
  const db = await mockSupabase(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await signIn(page);
  await expect(board(page)).toBeVisible();
  await openSignin(page);
  const card = page.locator('.set-card', { hasText: 'Passkeys' });
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await page.locator('dialog.modal.small[open]').locator('input.dlg-input').fill('My tablet');
  await page.locator('dialog.modal.small[open]').getByRole('button', { name: 'Continue' }).click();
  await expect(card.locator('.item-row')).toHaveCount(1);
  await expect(card.locator('.item-row b')).toHaveText('My tablet');
  expect(db.passkeys).toHaveLength(1);

  await page.locator('.settings-tab', { hasText: 'Account' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(board(page)).toBeVisible();
  expect(db.passkeys[0].last_used_at).toBeTruthy();
});
