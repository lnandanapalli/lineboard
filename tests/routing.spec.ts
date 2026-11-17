import { expect, test } from '@playwright/test';
import { mockSupabase } from './mockSupabase';

test('clean paths open directly and links and history navigate without a page reload', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A clear page.');
  await page.evaluate(() => { (window as any).__navigationMarker = 'same document'; });
  let documentRequests = 0;
  page.on('request', r => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documentRequests++; });
  await page.getByRole('link', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back.');
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make room for your ideas.');
  expect(await page.evaluate(() => (window as any).__navigationMarker)).toBe('same document');
  expect(documentRequests).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make room for your ideas.');
});

test('legacy hash bookmarks remain usable and native section anchors work', async ({ page }) => {
  for (const route of ['home', 'app', 'terms', 'privacy']) {
    await page.goto('/#' + route);
    await expect(page).toHaveURL(new RegExp('/' + route + '$'));
    if (route === 'app') await expect(page.locator('.canvas-area canvas.live')).toBeVisible();
    else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await page.goto('/home');
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await expect(page).toHaveURL(/\/home#how-it-works$/);
  await expect(page.getByRole('heading', { name: 'Made for the way you write.' })).toBeInViewport();
});
