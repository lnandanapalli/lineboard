import { expect, test } from '@playwright/test';
import { mockSupabase, MOCK_URL } from './mockSupabase';

test('new visitors get a homepage, with distinct login and signup routes and browser history', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
  await expect(page.locator('.auth-form')).toHaveCount(0);
  await page.getByRole('link', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make room for your ideas.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.locator('.auth-agreement')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back.');
});

test('signup submits to signup, explains email confirmation and opens policies without losing the form', async ({ page, context }) => {
  await mockSupabase(page);
  await page.route(`${MOCK_URL}/auth/v1/signup**`, route => route.fulfill({ json: { user: { id: 'new-user' }, session: null } }));
  await page.goto('/#signup');
  await page.getByLabel('Email', { exact: true }).fill('new@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  const popupPromise = context.waitForEvent('page');
  await page.locator('.auth-agreement').getByRole('link', { name: 'Privacy policy' }).click();
  const policy = await popupPromise;
  await expect(policy.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await policy.close();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('new@example.com');
  const request = page.waitForRequest(`${MOCK_URL}/auth/v1/signup**`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect((await request).postDataJSON().email).toBe('new@example.com');
  await expect(page.getByRole('status')).toContainText('Check your email');
});

test('login errors are actionable and password reset and email-link flows work', async ({ page }) => {
  await mockSupabase(page);
  await page.route(`${MOCK_URL}/auth/v1/recover**`, route => route.fulfill({ json: {} }));
  await page.route(`${MOCK_URL}/auth/v1/otp**`, route => route.fulfill({ json: {} }));
  await page.route(`${MOCK_URL}/auth/v1/token**`, route => route.fulfill({ status: 400, json: { msg: 'Invalid login credentials' } }));
  await page.goto('/#login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('wrongpassword');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Invalid login credentials');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toHaveText('Password reset link sent.');
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const request = page.waitForRequest(`${MOCK_URL}/auth/v1/otp**`);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  expect((await request).postDataJSON().create_user).toBe(false);
  await expect(page.getByRole('status')).toContainText('Sign-in link sent');
});

test('local homepage and policies are readable on mobile, with a working notebook entry', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
  expect(await page.locator('.public-page').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('link', { name: 'Privacy policy', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await page.getByRole('link', { name: 'Terms of service', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of service');
  await page.getByRole('link', { name: '← Home', exact: true }).click();
  await page.getByRole('button', { name: 'Try it without an account' }).click();
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
  await page.reload();
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
});

test('signed-in users resume notes, can read policies, and sign out to the homepage', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/#login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
  await page.goto('/#privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');
  await page.getByRole('link', { name: 'Back to notebook' }).click();
  await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.set-account')).toContainText('friend@example.com');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
});
