import { expect, test } from '@playwright/test';
import { PALM, PEN, drag, expectStrokes, send, setup, stripY, tapMargin, tp } from './helpers';
import { readFileSync } from 'node:fs';

/**
 * End-to-end tests for the strip lock and palm rejection.
 * Touches are sent through the Chrome DevTools Protocol so we can control contact size
 * (radiusX / radiusY), which the browser reports to the page as PointerEvent width / height.
 */


test('stylus draws in the unlocked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 400, stripY(geo, 0));
  await expectStrokes(page, 1);
});

test('touches in locked strips are ignored', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 3), geo.areaX + 400, stripY(geo, 3));
  await drag(cdp, geo.areaX + 100, stripY(geo, 5), geo.areaX + 300, stripY(geo, 5), PALM);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('palm-sized contacts in the unlocked strip are ignored', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 400, stripY(geo, 0), PALM);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('a contact that grows into a palm mid-stroke is cancelled', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const y = stripY(geo, 0);
  await send(cdp, 'touchStart', [tp(geo.areaX + 100, y, PEN, 1)]);
  await send(cdp, 'touchMove', [tp(geo.areaX + 120, y, PEN, 1)]);
  await send(cdp, 'touchMove', [tp(geo.areaX + 140, y, PALM, 1)]);
  await send(cdp, 'touchEnd', []);
  await page.waitForTimeout(200);
  await expectStrokes(page, 0);
});

test('stylus keeps drawing while a palm rests on a locked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const palm = tp(geo.areaX + 500, stripY(geo, 3), PALM, 9);
  await send(cdp, 'touchStart', [palm]);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 600, stripY(geo, 0), PEN, [palm]);
  await send(cdp, 'touchEnd', []);
  await expectStrokes(page, 1);
});

test('tapping the margin moves the unlocked strip', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await tapMargin(cdp, geo, 2);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0)); // strip 0 is now locked
  await drag(cdp, geo.areaX + 100, stripY(geo, 2), geo.areaX + 300, stripY(geo, 2));
  await expectStrokes(page, 1);
  await expect(page.locator('.strip-btn.on')).toHaveCount(1);
});

test('multi-strip mode allows strokes across strips and locks all when turned off', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await page.getByRole('switch').click();
  await tapMargin(cdp, geo, 4);
  await tapMargin(cdp, geo, 5);
  await expect(page.locator('.strip-btn.on')).toHaveCount(3); // strip 0 plus 4 and 5
  await drag(cdp, geo.areaX + 200, stripY(geo, 4) - 20, geo.areaX + 260, stripY(geo, 5) + 20);
  await expectStrokes(page, 1);

  await page.getByRole('switch').click();
  await expect(page.locator('.strip-btn.on')).toHaveCount(0);
  await drag(cdp, geo.areaX + 100, stripY(geo, 4), geo.areaX + 300, stripY(geo, 4));
  await page.waitForTimeout(200);
  await expectStrokes(page, 1);
});

test('undo, redo and eraser', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const y = stripY(geo, 0);
  await drag(cdp, geo.areaX + 100, y, geo.areaX + 300, y);
  await drag(cdp, geo.areaX + 400, y, geo.areaX + 600, y);
  await expectStrokes(page, 2);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expectStrokes(page, 1);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expectStrokes(page, 2);
  await page.getByRole('button', { name: 'Eraser' }).click();
  await drag(cdp, geo.areaX + 200, y - 30, geo.areaX + 200, y + 30);
  await expectStrokes(page, 1);
});

test('notes persist across reloads', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expectStrokes(page, 1);
  await page.reload();
  await page.locator('.canvas-area canvas.live').waitFor();
  await expectStrokes(page, 1);
  await expect(page.locator('.title-input')).not.toHaveValue('');
});

test('works under the production Content-Security-Policy', async ({ page }) => {
  // Apply the same CSP the Docker image sends, so a CSP-breaking change fails CI.
  const conf = readFileSync('docker/security-headers.conf', 'utf8');
  const csp = /Content-Security-Policy "([^"]+)"/.exec(conf)![1];
  await page.route('**/*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expectStrokes(page, 1);
  expect(violations).toEqual([]);
});
