import { expect, test, type Page } from '@playwright/test';
import { attachBoard, setup } from './helpers';
import { editDistance, normalize, parseQuery, score } from '../src/search';

/** Search: a window of its own, over note titles and notebook names, forgiving of typos. */

const openSidebar = async (page: Page) => {
  if (!(await page.locator('.app.sidebar-open').count())) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.waitForTimeout(300);
  }
};

async function newNote(page: Page, title: string) {
  await openSidebar(page);
  await page.getByRole('button', { name: 'New note' }).click();
  await page.locator('dialog[open] .dlg-input').fill(title);
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
}

async function newNotebook(page: Page, name: string) {
  await openSidebar(page);
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] .dlg-input').fill(name);
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
}

const search = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const results = (page: Page) => search(page).getByRole('option');

test('search opens in its own window from the sidebar or Ctrl+K, finds notes and notebooks, each labelled', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Thermodynamics lecture');
  await newNote(page, 'Shopping list');
  await newNotebook(page, 'Physics');
  await openSidebar(page);
  await page.getByRole('button', { name: /^Search/ }).click();
  await expect(search(page)).toBeVisible();
  // No query: the recent notes.
  await expect(search(page).locator('.search-status')).toHaveText('Recent notes');
  await page.keyboard.type('physic');
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText('Notebook');
  await expect(results(page).first()).toContainText('Physics');
  await page.keyboard.press('Escape');
  await expect(search(page)).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('thermo');
  await expect(results(page).first()).toContainText('Note');
  await expect(results(page).first()).toContainText('Thermodynamics lecture');
  await expect(results(page).first()).toContainText('My Notebook');
  await page.keyboard.press('Enter');
  await expect(search(page)).toHaveCount(0);
  await expect(page.locator('.title-input')).toHaveValue('Thermodynamics lecture');
  await expect(page.locator('.book-button')).toContainText('My Notebook');
});

test('typos, any word order and accents still match; "quotes" ask for the exact phrase', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Thermodynamics lecture');
  await newNote(page, 'Café menu ideas');
  await newNote(page, 'Lecture on waves');
  await page.keyboard.press('Control+k');
  const titles = () => results(page).locator('b').allTextContents();
  await page.keyboard.type('thermodinamics');
  await expect.poll(titles).toEqual(['Thermodynamics lecture']);
  await search(page).getByRole('combobox').fill('lecture thermo');
  await expect.poll(titles).toEqual(['Thermodynamics lecture']);
  await search(page).getByRole('combobox').fill('cafe');
  await expect.poll(titles).toEqual(['Café menu ideas']);
  await search(page).getByRole('combobox').fill('lecture');
  await expect.poll(titles).toEqual(expect.arrayContaining(['Thermodynamics lecture', 'Lecture on waves']));
  // The title that starts with it comes first.
  expect((await titles())[0]).toBe('Lecture on waves');
  await search(page).getByRole('combobox').fill('"on waves"');
  await expect.poll(titles).toEqual(['Lecture on waves']);
  await search(page).getByRole('combobox').fill('zzzz');
  await expect(search(page).locator('.search-status')).toContainText('Nothing found');
  // Arrow keys move through the results.
  await search(page).getByRole('combobox').fill('lecture');
  await page.keyboard.press('ArrowDown');
  await expect(results(page).nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('archived notes are left out unless asked for; opening one offers to restore it', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Old exam answers');
  await newNote(page, 'Something else');
  await openSidebar(page);
  await page.locator('.note-list li', { hasText: 'Old exam answers' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('exam');
  await expect(search(page).locator('.search-status')).toContainText('Nothing found');
  await search(page).getByText('Include archived').click();
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText('Archived');
  await results(page).first().click();
  await page.locator('dialog.modal.small').getByRole('button', { name: 'Restore and open' }).click();
  await expect(page.locator('.title-input')).toHaveValue('Old exam answers');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]').find((n: { title: string }) => n.title === 'Old exam answers')?.archived_at ?? null)).toBeNull();
  await page.reload();
  await attachBoard(page);
});

// ---------------- matching rules, without a browser ----------------

test('normalising ignores case, accents and punctuation', () => {
  expect(normalize('  Café — Menu!! ')).toBe('cafe menu');
  expect(normalize('Ünïcödé')).toBe('unicode');
});

test('edit distance counts swaps as one typo and stops early', () => {
  expect(editDistance('thermo', 'thremo', 1)).toBe(1);
  expect(editDistance('kitten', 'sitting', 3)).toBe(3);
  expect(editDistance('a', 'abcdef', 2)).toBe(3); // over the limit: limit + 1
});

test('scores rank exact over starts-with over a word start over a typo', () => {
  const q = parseQuery('wave');
  const exact = score('Wave', q);
  const starts = score('Waves and tides', q);
  const inner = score('Microwave notes', q);
  const typo = score('Cut', parseQuery('cat'));
  expect(exact).toBeGreaterThan(starts);
  expect(starts).toBeGreaterThan(inner);
  expect(inner).toBeGreaterThan(0);
  expect(typo).toBe(0); // words under 4 letters get no typo allowance
  expect(score('Wove', parseQuery('wave'))).toBeGreaterThan(0); // 4+ letters: one typo is fine
  expect(score('Thermodynamics', parseQuery('thermodinamics'))).toBeGreaterThan(0);
  expect(score('Lecture notes', parseQuery('"notes lecture"'))).toBe(0);
  // Very long queries are cut, not refused.
  expect(parseQuery('x'.repeat(5000)).whole.length).toBe(200);
});
