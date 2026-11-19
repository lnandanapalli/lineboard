import { test, type Page } from '@playwright/test';
import { send, tp } from './helpers';

/**
 * Builds the README screenshot (docs/screenshot.png) by writing a page through the app itself.
 * Skipped in the normal test run; regenerate with `npm run screenshot`.
 */
test.skip(!process.env.SCREENSHOT, 'run with npm run screenshot');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, storageState: { cookies: [], origins: [{ origin: 'http://localhost:4173', localStorage: [{ name: 'lb-storage-notice', value: 'true' }, { name: 'lb-hint-dismissed', value: 'true' }, { name: 'lb-settings-local', value: JSON.stringify({ mode: 'free' }) }] }] } });

test('screenshot', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/app');
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  const cdp = await page.context().newCDPSession(page);
  const area = (await page.locator('.canvas-area').boundingBox())!;
  const k = area.width / 1000;
  const at = (x: number, y: number) => ({ x: area.x + x * k, y: area.y + y * k });
  const R = 1;

  const stroke = async (pts: [number, number][]) => {
    const p0 = at(...pts[0]);
    await send(cdp, 'touchStart', [tp(p0.x, p0.y, R, 1)]);
    for (const p of pts.slice(1)) {
      const q = at(...p);
      await send(cdp, 'touchMove', [tp(q.x, q.y, R, 1)]);
    }
    await send(cdp, 'touchEnd', []);
  };
  // A slightly wobbly line, like a hand-drawn one.
  const wobbly = (x0: number, y0: number, x1: number, y1: number, n = 24, amp = 1.2): [number, number][] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n;
      return [x0 + (x1 - x0) * t + Math.sin(i * 1.7) * amp * 0.3, y0 + (y1 - y0) * t + Math.sin(i * 2.3) * amp];
    });
  const color = async (c: string) => page.getByRole('button', { name: 'Color ' + c }).click();
  const tool = async (key: string) => page.keyboard.press(key);

  async function text(x: number, y: number, s: string, opts: { size?: 'up' | 'up2' | 'down'; bold?: boolean } = {}) {
    await tool('t');
    const p = at(x, y);
    await send(cdp, 'touchStart', [tp(p.x, p.y, 3, 2)]);
    await send(cdp, 'touchEnd', []);
    const bar = page.getByRole('toolbar', { name: 'Text format' });
    await bar.getByRole('radio', { name: 'Handwriting' }).click();
    const want = opts.size === 'up2' ? 44 : opts.size === 'up' ? 36 : opts.size === 'down' ? 24 : 28;
    for (let i = 0; i < 6; i++) {
      const cur = Number(await bar.locator('.tb-size').textContent());
      if (cur === want) break;
      await bar.getByRole('button', { name: cur < want ? 'Larger text' : 'Smaller text' }).click();
    }
    const b = bar.getByRole('button', { name: 'Bold' });
    if ((await b.getAttribute('aria-pressed')) !== String(!!opts.bold)) await b.click();
    await page.keyboard.type(s);
    await page.keyboard.press('Escape');
  }

  async function shape(name: string, x0: number, y0: number, x1: number, y1: number, style = 'Solid', thick = 'Medium') {
    await page.locator('.shape-btn').click();
    await page.getByRole('radiogroup', { name: 'Line style' }).getByRole('radio', { name: style }).click();
    await page.getByRole('radiogroup', { name: 'Thickness' }).getByRole('radio', { name: thick, exact: true }).click();
    await page.locator('.shape-grid').getByRole('radio', { name, exact: true }).click();
    await stroke([[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]]);
  }

  // ---- left: notes ----
  await color('#111827');
  await text(40, 40, 'Simple pendulum', { size: 'up2', bold: true });
  await tool('p');
  await stroke(wobbly(42, 88, 330, 90, 30, 1.5)); // underline
  await text(60, 135, '•  Period:  T = 2π √(L / g)');
  await text(60, 185, '•  Does not depend on the mass');
  await text(60, 235, '•  Small swings only (θ < 15°)');
  await tool('h');
  await stroke([[172, 94], [255, 95], [335, 93]]); // highlight the formula
  // ---- right: the diagram ----
  await tool('p');
  await color('#111827');
  await stroke(wobbly(610, 70, 900, 70, 30, 0.8)); // ceiling
  for (let x = 625; x < 900; x += 22) await stroke([[x, 70], [x - 12, 56]]); // hatching
  await stroke(wobbly(760, 70, 690, 290, 26, 0.6)); // string
  await shape('Line', 760, 72, 760, 320, 'Dotted', 'Thin'); // rest position
  await color('#2563eb');
  await shape('Ellipse', 668, 268, 712, 312, 'Solid', 'Bold'); // bob
  await color('#dc2626');
  await shape('Arrow line', 690, 318, 690, 395, 'Solid', 'Medium'); // weight
  await color('#111827');
  await text(700, 372, 'mg', { size: 'down' });
  await text(705, 150, 'L', { size: 'down' });
  await text(770, 108, 'θ', { size: 'down' });
  await color('#16a34a');
  await shape('Double arrow line', 600, 345, 660, 330, 'Dashed', 'Thin'); // swing

  // ---- lower: the motion ----
  await color('#111827');
  await text(60, 330, 'x(t) = A cos(ωt)');
  await tool('p');
  await stroke(wobbly(60, 420, 560, 420, 40, 0.6)); // time axis
  await stroke(wobbly(70, 470, 70, 350, 20, 0.5)); // x axis
  await color('#9333ea');
  const wave: [number, number][] = [];
  for (let i = 0; i <= 90; i++) {
    const x = 72 + i * 5.4;
    wave.push([x, 420 - 52 * Math.cos(i / 9.5) + Math.sin(i * 1.3) * 0.6]);
  }
  await stroke(wave);
  await color('#111827');
  await text(570, 405, 't', { size: 'down' });

  // ---- to-do, bottom right ----
  await shape('Check box', 620, 455, 650, 485, 'Solid', 'Medium');
  await text(665, 452, 'Lab report due Friday');
  await shape('Rectangle', 620, 505, 650, 535, 'Solid', 'Medium');
  await text(665, 502, 'Measure T for L = 0.5 m, 1 m');

  // Title, then the default mode: split (top half open, bottom half palm-safe).
  await page.locator('.title-input').fill('Physics — Lecture 4');
  await page.locator('.title-input').press('Enter');
  await page.locator('.mode-btn').click();
  await page.getByRole('menuitemradio', { name: /^Split/ }).click();
  await page.keyboard.press('p');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(3500); // let the mode toast fade
  await page.screenshot({ path: 'docs/screenshot.png' });
});
