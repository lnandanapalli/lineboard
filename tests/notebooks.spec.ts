import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, expectStrokes, setup, stripY } from './helpers';
import { mockSupabase, USER_ID } from './mockSupabase';

/** Notebooks: two levels (notebook -> notes), in local mode and with an account. */

const openSidebar = (page: Page) => page.getByRole('button', { name: 'Notes', exact: true }).click();
const notebookButton = (page: Page) => page.locator('.book-button');
const noteTitles = (page: Page) => page.locator('.note-list .note-title');
/** Close the sidebar and let its slide-out finish, as a person would before writing. */
async function closeSidebar(page: Page) {
  await page.locator(".scrim").click();
  await page.waitForTimeout(300);
}

async function openNotebookList(page: Page) {
  if (!(await page.locator('.book-panel').isVisible())) await notebookButton(page).click();
}

async function answerDialog(page: Page, button: string, text?: string) {
  const dlg = page.locator('dialog[open]');
  if (text !== undefined) await dlg.locator('input.dlg-input').fill(text);
  await dlg.getByRole('button', { name: button }).click();
}

async function newNotebook(page: Page, name: string) {
  if (!(await page.locator('.book-panel').isVisible())) await notebookButton(page).click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await answerDialog(page, 'Create', name);
  await expect(notebookButton(page)).toContainText(name);
}

async function switchTo(page: Page, name: string) {
  await notebookButton(page).click();
  await page.locator('.book-list .book-open', { hasText: name }).click();
  await expect(notebookButton(page)).toContainText(name);
}

test('starts with "My Notebook" holding the first note', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await expect(notebookButton(page)).toContainText('My Notebook');
  await expect(noteTitles(page)).toHaveCount(1);
  await notebookButton(page).click();
  await expect(page.locator('.book-list li', { hasText: 'My Notebook' }).locator('.book-count')).toHaveText('1');
});

test('each notebook shows only its own notes, and the last one reopens after a reload', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await openSidebar(page);
  await newNotebook(page, 'Physics');
  await expect(noteTitles(page)).toHaveCount(1); // a fresh note in the new notebook
  await expectStrokes(page, 1); // the first note's ink is untouched

  await switchTo(page, 'My Notebook');
  await expect(noteTitles(page)).toHaveCount(1);
  await switchTo(page, 'Physics');

  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(notebookButton(page)).toContainText('Physics');
});

test('a note can be moved to another notebook', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await newNotebook(page, 'Physics');
  await switchTo(page, 'My Notebook');
  await page.locator('.title-input').fill('Move me');
  await page.locator('.title-input').press('Enter');

  await page.locator('.note-list li', { hasText: 'Move me' }).getByRole('button', { name: 'Move to another notebook' }).click();
  await page.locator('dialog[open] select').selectOption({ label: 'Physics' });
  await answerDialog(page, 'Move');

  // The open note follows the move.
  await expect(notebookButton(page)).toContainText('Physics');
  await expect(noteTitles(page)).toContainText(['Move me']);
  await switchTo(page, 'My Notebook');
  await expect(page.locator('.note-list .note-title', { hasText: 'Move me' })).toHaveCount(0);
});

test('deleting a notebook deletes its notes; deleting the last one leaves a fresh "My Notebook"', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await openSidebar(page);
  await newNotebook(page, 'Scratch');
  await closeSidebar(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expectStrokes(page, 1);

  await openSidebar(page);
  await notebookButton(page).click();
  await page.locator('.book-list li', { hasText: 'Scratch' }).getByRole('button', { name: 'Delete notebook' }).click();
  await expect(page.locator('dialog[open] p')).toContainText('its 1 note');
  await answerDialog(page, 'Delete notebook');
  await expect(notebookButton(page)).toContainText('My Notebook');
  await expectStrokes(page, 0);

  await openNotebookList(page);
  await page.locator('.book-list li', { hasText: 'My Notebook' }).getByRole('button', { name: 'Delete notebook' }).click();
  await answerDialog(page, 'Delete notebook');
  await expect(notebookButton(page)).toContainText('My Notebook');
  await expect(noteTitles(page)).toHaveCount(1);
});

test('notes saved before notebooks existed are filed into "My Notebook"', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('lb-local-notes')) return;
    const now = new Date().toISOString();
    localStorage.setItem('lb-local-notes', JSON.stringify([{ id: 'old-1', title: 'Old note', created_at: now, updated_at: now }]));
  });
  await setup(page);
  await openSidebar(page);
  await expect(notebookButton(page)).toContainText('My Notebook');
  await expect(noteTitles(page)).toContainText(['Old note']);
});

test('with an account: older notes are filed into a default notebook that has the user id', async ({ page }) => {
  const db = await mockSupabase(page);
  const now = new Date().toISOString();
  db.notes.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', user_id: USER_ID, title: 'From before', notebook_id: null, created_at: now, updated_at: now });
  await page.goto('/');
  await page.getByPlaceholder('Email').fill('friend@example.com');
  await page.getByPlaceholder('Password').fill('secret123');
  await page.locator('form.auth-form button[type=submit]').click();
  await attachBoard(page);
  await expect(page.locator('.title-input')).toHaveValue('From before');
  expect(db.notebooks.map((b) => b.id)).toEqual([USER_ID]);
  expect(db.notes[0].notebook_id).toBe(USER_ID);
});

test('guest notebooks move into the account, merging into a same-named notebook', async ({ page }) => {
  const db = await mockSupabase(page);
  db.notebooks.push({ id: USER_ID, user_id: USER_ID, name: 'My Notebook', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });

  await page.goto('/');
  await page.getByRole('button', { name: 'Try it without an account' }).click();
  const { cdp, geo } = await attachBoard(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0)); // in guest "My Notebook"
  await openSidebar(page);
  await newNotebook(page, 'Physics');
  await closeSidebar(page);
  await drag(cdp, geo.areaX + 100, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0)); // in "Physics"

  await page.locator('.toolbar .signin-save').click();
  await page.getByPlaceholder('Email').fill('friend@example.com');
  await page.getByPlaceholder('Password').fill('secret123');
  await page.locator('form.auth-form button[type=submit]').click();
  await attachBoard(page);

  await expect.poll(() => db.strokes.length).toBe(2);
  const names = db.notebooks.map((b) => b.name).sort();
  expect(names).toEqual(['My Notebook', 'Physics']); // no duplicate "My Notebook"
  const physics = db.notebooks.find((b) => b.name === 'Physics')!;
  const notebookOf = (strokeIdx: number) => db.notes.find((n) => n.id === db.strokes[strokeIdx].note_id)!.notebook_id;
  expect([notebookOf(0), notebookOf(1)].sort()).toEqual([USER_ID, physics.id].sort());
});
