import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, setup, stripY } from './helpers';
import { mockSupabase } from './mockSupabase';

/** The sidebar's ⋯ menus, stars, the archive (Settings > Data controls) and sharing as a file. */

type N = { id: string; title: string; notebook_id: string; starred?: boolean; archived_at?: string | null };
const notes = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]') as N[]);
const books = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('lb-local-notebooks') ?? '[]') as (N & { name: string })[]);

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

const noteRow = (page: Page, title: string) => page.locator('.note-list li', { has: page.locator('.note-title', { hasText: title }) });

async function rowAction(page: Page, row: ReturnType<typeof noteRow>, action: string) {
  await row.first().locator('.more-btn').click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('the ⋯ menu holds a note’s actions; a starred note is pinned under "Starred", from any notebook', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Physics');
  await newNote(page, 'Chemistry');
  await openSidebar(page);
  await noteRow(page, 'Physics').locator('.more-btn').click();
  await expect(page.getByRole('menu')).toContainText('Rename');
  await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Move to notebook', 'Share', 'Export (.lbd)', 'Archive', 'Delete']);
  await page.keyboard.press('Escape');

  await noteRow(page, 'Physics').getByRole('button', { name: 'Star "Physics"' }).click();
  await expect(page.locator('.list-label').first()).toHaveText('Starred');
  await expect(noteRow(page, 'Physics')).toHaveCount(1); // only under "Starred", not twice
  await expect(page.locator('.note-list li:not(.list-label) .note-title').first()).toHaveText('Physics');
  await expect.poll(async () => (await notes(page)).find((n) => n.title === 'Physics')?.starred).toBe(true);
  // Stars keep after a reload.
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(noteRow(page, 'Physics').first().getByRole('button', { name: 'Unstar "Physics"' })).toHaveAttribute('aria-pressed', 'true');

  // Another notebook: the starred note is still there, labelled with its notebook.
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Maths');
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  await openSidebar(page);
  await expect(noteRow(page, 'Physics')).toHaveCount(1);
  await expect(noteRow(page, 'Physics')).toContainText('My Notebook');
  await noteRow(page, 'Physics').locator('.note-open').click();
  await expect(page.locator('.book-button')).toContainText('My Notebook');
  await expect(page.locator('.title-input')).toHaveValue('Physics');
});

test('starred notebooks come first', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Zoology');
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  await openSidebar(page);
  await page.locator('.book-button').click();
  await expect(page.locator('.book-title')).toHaveText(['My Notebook', 'Zoology']);
  await page.getByRole('button', { name: 'Star "Zoology"' }).click();
  await expect(page.locator('.book-title')).toHaveText(['Zoology', 'My Notebook']);
  expect((await books(page)).find((b) => b.name === 'Zoology')?.starred).toBe(true);
});

test('archiving hides a note or notebook; Settings > Data controls lists them to restore or delete', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Old ideas');
  await newNote(page, 'Current');
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Old ideas'), 'Archive');
  await expect(page.locator('#toast')).toContainText('Archived "Old ideas"');
  await expect(noteRow(page, 'Old ideas')).toHaveCount(0);
  expect((await notes(page)).find((n) => n.title === 'Old ideas')?.archived_at).toBeTruthy();

  // The only notebook cannot be archived.
  await page.locator('.book-button').click();
  await page.locator('.book-list li').first().locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.locator('#toast')).toContainText('Keep at least one notebook');

  await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  const archived = page.locator('.archived-items li');
  await expect(archived).toHaveCount(1);
  await expect(archived).toContainText('Old ideas');
  await expect(archived).toContainText('in My Notebook');
  await archived.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.archived-list')).toContainText('Nothing is archived');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await expect(noteRow(page, 'Old ideas')).toHaveCount(1);

  // Archive again, then delete it from Data controls.
  await rowAction(page, noteRow(page, 'Old ideas'), 'Archive');
  await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  await page.locator('.archived-items li').getByRole('button', { name: 'Delete "Old ideas"' }).click();
  await page.locator('dialog.modal.small').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.archived-list')).toContainText('Nothing is archived');
  expect((await notes(page)).map((n) => n.title)).not.toContain('Old ideas');
});

test('an archived notebook takes its notes with it, and comes back with them', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Old term');
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  await openSidebar(page);
  await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  // It was open: the app moves to the other notebook.
  await expect(page.locator('.book-button')).toContainText('My Notebook');
  await page.locator('.book-button').click();
  await expect(page.locator('.book-title')).toHaveText(['My Notebook']);
  await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  await expect(page.locator('.archived-items li')).toContainText('Old term');
  await expect(page.locator('.archived-items li')).toContainText('1 note');
  await page.locator('.archived-items li').getByRole('button', { name: 'Restore' }).click();
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await page.locator('.book-button').click();
  await expect(page.locator('.book-title')).toHaveText(['My Notebook', 'Old term']);
});

test('Share sends a PDF, picture or Lineboard file from the device (here: downloaded)', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 50, stripY(geo, 0), geo.areaX + 250, stripY(geo, 0));
  await page.locator('.title-input').fill('Waves');
  await page.locator('.title-input').press('Enter');
  const share = async (choice: string) => {
    await page.getByRole('button', { name: 'Share or export', exact: true }).click();
    await page.getByRole('button', { name: /^Share…/ }).click();
    await page.locator('dialog[open] select').selectOption({ label: choice });
    const wait = page.waitForEvent('download');
    await page.locator('dialog').getByRole('button', { name: 'Share' }).click();
    const d = await wait;
    return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
  };
  const pdf = await share('PDF');
  expect(pdf.name).toBe('Waves.pdf');
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.bytes.toString('latin1')).toContain('/Title (Waves)');
  expect(pdf.bytes.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  const png = await share('Picture (.png)');
  expect(png.name).toBe('Waves.png');
  expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
  const lbd = await share('Lineboard file (.lbd)');
  expect(lbd.name).toBe('Waves.lbd');
  expect(lbd.bytes.readUInt32LE(0)).toBe(0x04034b50);
  await expect(page.locator('#toast')).toContainText('Send it however you like');
});

test('signed in, stars and the archive sync to the account; an older database says it needs an update', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  await openSidebar(page);
  const title = (await page.locator('.note-title').first().textContent())!;
  await noteRow(page, title).getByRole('button', { name: `Star "${title}"` }).click();
  await expect.poll(() => db.notes[0].starred).toBe(true);
  await rowAction(page, noteRow(page, title), 'Archive');
  await expect.poll(() => db.notes.find((n) => n.title === title)?.archived_at).toBeTruthy();

  db.noFlags = true;
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  const t2 = (await page.locator('.note-title').first().textContent())!;
  await noteRow(page, t2).getByRole('button', { name: `Star "${t2}"` }).click();
  await expect(page.locator('#toast')).toContainText('database update');
  await expect(noteRow(page, t2).getByRole('button', { name: `Star "${t2}"` })).toHaveAttribute('aria-pressed', 'false');
});

test('a PDF keeps a 200-character title ending in a bracket intact', async ({ page }) => {
  await setup(page);
  const title = 'x'.repeat(199) + ')';
  await openSidebar(page);
  await page.locator('.note-list li').first().locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.locator('dialog[open] .dlg-input').fill(title);
  await page.locator('dialog').getByRole('button', { name: 'Rename' }).click();
  await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Share or export', exact: true }).click();
  await page.getByRole('button', { name: /^Share…/ }).click();
  await page.locator('dialog[open] select').selectOption({ label: 'PDF' });
  const wait = page.waitForEvent('download');
  await page.locator('dialog').getByRole('button', { name: 'Share' }).click();
  const bytes = readFileSync((await (await wait).path())!).toString('latin1');
  // The bracket is escaped and the string is closed: "(xxx…\))", then the next key.
  expect(bytes).toContain(`/Title (${'x'.repeat(199)}\\)) /Producer`);
});
