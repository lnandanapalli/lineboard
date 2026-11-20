import { expect, test } from '@playwright/test';
import { PALM, PEN, expectStrokes, send, setup, stripY, tp, type Geo } from './helpers';
import { mockSupabase } from './mockSupabase';
import { limitFrom, PalmLearner, LEARN_LIMIT } from '../src/palm';
import { emailLimit } from '../src/emailLimit';
import type { CDPSession } from '@playwright/test';

/** First steps: creating an account without hitting Supabase's email wait, and writing with any finger or stylus. */

test('after creating an account: a clear "check your email" screen, and Resend counts down the wait', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill('new@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const panel = page.locator('.auth-sent');
  await expect(panel).toContainText('Check your email');
  await expect(panel).toContainText('new@example.com');
  // The form is gone, so it cannot be sent twice by mistake; Resend waits out the 60 seconds.
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeHidden();
  const resend = panel.getByRole('button', { name: /Resend confirmation email/ });
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/\(\d+s\)/);
  expect(db.emails?.length).toBe(1);
  // "Use a different email" brings the form back.
  await panel.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
});

test('Supabase’s wait between emails is explained with a live countdown, not its raw message', async ({ page }) => {
  const db = await mockSupabase(page);
  db.emails = [{ to: 'new@example.com', at: Date.now() - 15_000, kind: 'signup' }]; // sent 15 s ago
  await page.goto('/signup');
  await page.getByLabel('Email', { exact: true }).fill('new@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  const submit = page.getByRole('button', { name: 'Create account', exact: true });
  await submit.click();
  const msg = page.locator('.auth-msg.err');
  await expect(msg).toContainText('a new one can be sent in');
  await expect(msg).not.toContainText('For security purposes');
  const first = Number(/in (\d+) second/.exec((await msg.textContent())!)![1]);
  expect(first).toBeGreaterThan(40);
  expect(first).toBeLessThanOrEqual(45);
  await expect(submit).toBeDisabled();
  await expect.poll(async () => Number(/in (\d+) second/.exec((await msg.textContent()) ?? '')?.[1])).toBeLessThan(first);
});

// ---------------- automatic palm detection ----------------

async function stroke(cdp: CDPSession, geo: Geo, strip: number, r: number, x = 80) {
  const y = stripY(geo, strip);
  await send(cdp, 'touchStart', [tp(geo.areaX + x, y, r, 1)]);
  for (let i = 1; i <= 15; i++) await send(cdp, 'touchMove', [tp(geo.areaX + x + i * 10, y, r, 1)]);
  await send(cdp, 'touchEnd', []);
}

test('a finger writes from the start (no calibration); after a few strokes a palm is still kept out', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // 56 px across: a broad fingertip, which the old fixed 45 px limit took for a palm.
  const FINGER = 28;
  for (let i = 0; i < 4; i++) await stroke(cdp, geo, 0, FINGER, 60 + i * 5);
  await expectStrokes(page, 4);
  // Learned: a palm next to that finger (140 px across) does not write.
  await stroke(cdp, geo, 0, 70);
  await page.waitForTimeout(200);
  await expectStrokes(page, 4);
  // Settings say what was learned.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Stylus & palm' }).click();
  await expect(page.locator('.palm-status')).toContainText('Learned from your writing');
});

test('someone writing with a big contact is adjusted to after a few tries; a resting palm never is', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // A resting palm, still, many times: never learned from.
  for (let i = 0; i < 5; i++) {
    await send(cdp, 'touchStart', [tp(geo.areaX + 200, stripY(geo, 0), PALM, 2)]);
    await send(cdp, 'touchEnd', []);
  }
  await page.waitForTimeout(150);
  await expectStrokes(page, 0);
  // A big contact (90 px) moving like writing: refused at first, then taken.
  const BIG = 45;
  for (let i = 0; i < 3; i++) await stroke(cdp, geo, 0, BIG);
  await expect(page.locator('#toast')).toContainText('Adjusted to how you write');
  await stroke(cdp, geo, 0, BIG);
  await expectStrokes(page, 1);
});

test('taps on a locked part of the page explain how to write there', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  for (let i = 0; i < 3; i++) {
    await send(cdp, 'touchStart', [tp(geo.areaX + 200, stripY(geo, 5), PEN, 3)]);
    await send(cdp, 'touchEnd', []);
  }
  await expect(page.locator('#toast')).toContainText('locked');
});

test('manual palm detection keeps a limit someone set before; everyone else gets automatic', async () => {
  const { withDefaults } = await import('../src/types');
  expect(withDefaults({}).palmMode).toBe('auto');
  expect(withDefaults({ touchThreshold: 45 }).palmMode).toBe('auto');
  expect(withDefaults({ touchThreshold: 70 }).palmMode).toBe('manual');
  expect(withDefaults({ touchThreshold: 70, palmMode: 'auto' }).palmMode).toBe('auto');
});

test('the learned limit sits comfortably above the writing contact', () => {
  expect(limitFrom([4, 5, 6, 5])).toBe(20); // a fine tip: the minimum
  expect(limitFrom([26, 28, 24, 30])).toBe(Math.round(Math.max(28 * 1.7, 30 * 1.3) + 6));
  expect(limitFrom([0, 0, 1, 0])).toBe(Infinity); // size not reported: not used
  expect(limitFrom([140, 150, 145, 150])).toBe(150);
  const p = new PalmLearner();
  expect(p.threshold).toBe(LEARN_LIMIT);
  for (const s of [20, 22, 21, 23]) p.record(s);
  expect(p.learning).toBe(false);
  // Three refused writing attempts within 10 s: learn again with room for that contact.
  expect(p.missed(90, 0)).toBe(false);
  expect(p.missed(90, 1000)).toBe(false);
  expect(p.missed(90, 2000)).toBe(true);
  expect(p.learning).toBe(true);
  expect(p.threshold).toBeGreaterThan(90);
  // Spread out over time, they do not count.
  const q = new PalmLearner();
  expect(q.missed(90, 0) || q.missed(90, 11_000) || q.missed(90, 22_000)).toBe(false);
  expect(emailLimit({ message: 'For security purposes, you can only request this after 42 seconds.' })?.wait).toBe(42);
  expect(emailLimit({ message: 'email rate limit exceeded', code: 'over_email_send_rate_limit' })?.wait).toBe(0);
  expect(emailLimit({ message: 'Invalid login credentials' })).toBeNull();
});
