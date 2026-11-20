import { expect, test, type Page } from '@playwright/test';
import { expectStrokes, send, setup, stripY, tp, type Geo } from './helpers';
import type { CDPSession } from '@playwright/test';
import { PalmLearner } from '../src/palm';

/** Strokes never vanish because a finger or soft stylus widens as it draws. */

async function line(cdp: CDPSession, geo: Geo, r: number) {
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 80, y, r, 1)]);
  for (let i = 1; i <= 15; i++) await send(cdp, 'touchMove', [tp(geo.areaX + 80 + i * 10, y, r, 1)]);
  await send(cdp, 'touchEnd', []);
}

/** A long circling stroke (about a second) whose contact widens to `wide` halfway through. */
async function squiggle(page: Page, cdp: CDPSession, geo: Geo, r: number, wide: number) {
  const cx = geo.areaX + 300, cy = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(cx + 25, cy, r, 1)]);
  for (let i = 1; i <= 40; i++) {
    const a = (i / 10) * Math.PI;
    await send(cdp, 'touchMove', [tp(cx + 25 * Math.cos(a) + i * 3, cy + 20 * Math.sin(a), i > 20 ? wide : r, 1)]);
    await page.waitForTimeout(25);
  }
  await send(cdp, 'touchEnd', []);
}

test('a long squiggle whose contact widens partway is kept, and strokes like it then write at once', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  // Learn a 20 px fingertip (limit about 40 px).
  for (let i = 0; i < 4; i++) await line(cdp, geo, 10);
  await expectStrokes(page, 4);
  // A second into a circle the contact widens to 48 px: past the limit, but it is writing.
  await squiggle(page, cdp, geo, 10, 24);
  await expectStrokes(page, 5);
  // The limit made room: a stroke at that width writes from its start.
  await line(cdp, geo, 24);
  await expectStrokes(page, 6);
});

test('a sudden huge contact late in a stroke ends it there, keeping what was drawn', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  for (let i = 0; i < 4; i++) await line(cdp, geo, 10);
  await squiggle(page, cdp, geo, 10, 60); // 120 px: more than twice the limit
  await expectStrokes(page, 5);
});

test('widening raises a learned limit, never lowers it, and stays within the maximum', () => {
  const p = new PalmLearner();
  for (const s of [20, 20, 20, 20]) p.record(s);
  const learned = p.threshold;
  p.widen(10);
  expect(p.threshold).toBe(learned);
  p.widen(48);
  expect(p.threshold).toBe(Math.round(48 * 1.3 + 6));
  p.widen(500);
  expect(p.threshold).toBe(150);
});
