import { expect, test, type Browser, type Page } from '@playwright/test';
import { TEST_STORAGE } from './storageState';
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
  const context = await browser.newContext({ baseURL: 'http://localhost:4173', viewport: { width: 800, height: 1280 }, hasTouch: true, serviceWorkers: 'block', storageState: TEST_STORAGE, userAgent });
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
  const [current, a, b] = [0, 1, 2].map((i) => dlg.locator('input[type=password]').nth(i));
  // The current password is required, and checked.
  await a.fill('new password 1');
  await b.fill('new password 1');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('Enter your current password');
  await current.fill('not my password');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('not right');
  expect(db.passwordChanges).toBe(0);
  await current.fill('secret123');
  await b.fill('new password 2');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('do not match');
  await b.fill('new password 1');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg).toHaveCount(0);
  expect(db.passwordChanges).toBe(1);
  expect(db.password).toBe('new password 1');
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
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('wrong');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(confirm.locator('.enc-error')).toContainText('not right');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
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
  await page.locator('dialog.confirm-dialog input[type=password]').fill('secret123');
  await page.locator('dialog.confirm-dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('dialog.confirm-dialog')).toHaveCount(0); // checking the password takes a moment
  const naming = page.locator('dialog.modal.small[open]', { hasText: 'Add a passkey' });
  await naming.locator('input.dlg-input').fill('My tablet');
  await naming.getByRole('button', { name: 'Continue' }).click();
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

test('someone at an unlocked device cannot add a passkey or authenticator without the password', async ({ page }) => {
  const db = await mockSupabase(page);
  await signIn(page);
  await expect(board(page)).toBeVisible();
  await openSignin(page);
  for (const name of ['Add a passkey', 'Set up authenticator app']) {
    await page.getByRole('button', { name }).click();
    const confirm = page.locator('dialog.confirm-dialog');
    await expect(confirm).toContainText('Confirm it’s you');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
  }
  await expect(page.locator('dialog.mfa-dialog')).toHaveCount(0);
  expect(db.passkeys).toHaveLength(0);
  expect(db.factors).toHaveLength(0);
});

test('with two-step verification on, sensitive actions need the password and a code: a stolen password alone is not enough', async ({ page }) => {
  const db = await mockSupabase(page);
  db.factors.push({ id: 'f1', factor_type: 'totp', friendly_name: 'Phone', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  await signIn(page);
  await page.getByLabel('Code').fill(MOCK_TOTP);
  await expect(board(page)).toBeVisible();
  // Later (a reload: no recent proof on this page), someone tries to add their own passkey.
  await page.reload();
  await expect(board(page)).toBeVisible();
  await openSignin(page);
  const add = page.locator('.set-card', { hasText: 'Passkeys' }).getByRole('button', { name: 'Add a passkey' });
  await add.click();
  const confirm = page.locator('dialog.confirm-dialog');
  await expect(confirm).toContainText('step 1 of 2');
  await expect(confirm.getByRole('button', { name: /authenticator app instead/ })).toHaveCount(0); // no way around the password
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  // The right password is not enough: the code is asked next, and a wrong one is refused.
  await expect(confirm).toContainText('step 2 of 2');
  await confirm.getByLabel('6-digit code').fill('000000');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(confirm.locator('.enc-error')).toContainText('not right');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('dialog.modal.small[open]', { hasText: 'Add a passkey' })).toHaveCount(0);

  // With both, it goes ahead (and the password is not asked again within a few minutes).
  await add.click();
  await expect(confirm).toContainText('Enter the 6-digit code');
  await confirm.getByLabel('6-digit code').fill(MOCK_TOTP);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('dialog.modal.small[open]')).toContainText('Add a passkey'); // on to the next step
});

test('with two-step verification on, changing the password needs a code too', async ({ page }) => {
  const db = await mockSupabase(page);
  db.factors.push({ id: 'f1', factor_type: 'totp', friendly_name: 'Phone', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  await signIn(page);
  await page.getByLabel('Code').fill(MOCK_TOTP);
  await expect(board(page)).toBeVisible();
  await openSignin(page);
  await page.getByRole('button', { name: 'Change password' }).click();
  const dlg = page.locator('dialog[open].modal.small');
  const [current, a, b] = [0, 1, 2].map((i) => dlg.locator('input[type=password]').nth(i));
  await current.fill('secret123');
  await a.fill('a much better password');
  await b.fill('a much better password');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('6-digit code');
  expect(db.passwordChanges).toBe(0);
  await dlg.getByLabel('6-digit code from your authenticator app').fill('000000');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect(dlg.locator('.enc-error')).toContainText('not right');
  expect(db.passwordChanges).toBe(0);
  await dlg.getByLabel('6-digit code from your authenticator app').fill(MOCK_TOTP);
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await expect.poll(() => db.passwordChanges).toBe(1);
});

test('with two-step verification on, deleting the account takes the password and a fresh code, which the server sees', async ({ page }) => {
  const db = await mockSupabase(page);
  db.factors.push({ id: 'f1', factor_type: 'totp', friendly_name: 'Phone', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  await signIn(page);
  await page.getByLabel('Code').fill(MOCK_TOTP);
  await expect(board(page)).toBeVisible();
  // Signed in long ago: this session's token shows only old proofs.
  const old = Math.floor(Date.now() / 1000) - 3600;
  for (const s of db.sessions) Object.assign(s, { authAt: old, codeAt: old });
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      const v = JSON.parse(localStorage.getItem(k)!);
      v.expires_at = Math.floor(Date.now() / 1000) - 10;
      localStorage.setItem(k, JSON.stringify(v));
    }
  });
  await page.reload();
  await expect(board(page)).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  const dlg = page.locator('dialog.modal.small[open]');
  await dlg.locator('input').fill('DELETE');
  await dlg.getByRole('button', { name: 'Delete account', exact: true }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await confirm.getByLabel('6-digit code').fill(MOCK_TOTP);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/home$/);
  expect(db.deleted).toBe(true);
});
