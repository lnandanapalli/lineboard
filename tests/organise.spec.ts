import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, setup, stripY } from './helpers';
import { mockSupabase } from './mockSupabase';

/** The sidebar's ⋯ menus, stars, the archive (Settings > Data controls) and sharing as a file. */

type N = { id: string; title: string; notebook_id: string; starred?: boolean; archived_at?: string | null; deleted_at?: string | null };
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
  await expect(page.locator('.archived-list:not(.trash-list)')).toContainText('Nothing is archived');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await expect(noteRow(page, 'Old ideas')).toHaveCount(1);

  // Archive again, then delete it from Data controls: it goes to the trash.
  await rowAction(page, noteRow(page, 'Old ideas'), 'Archive');
  await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  await page.locator('.archived-list:not(.trash-list) .archived-items li').getByRole('button', { name: 'Delete "Old ideas"' }).click();
  await expect(page.locator('.archived-list:not(.trash-list)')).toContainText('Nothing is archived');
  await expect(page.locator('.trash-list')).toContainText('Old ideas');
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

const strokesOf = (page: Page, id: string) => page.evaluate((id) => JSON.parse(localStorage.getItem('lb-local-strokes-' + id) ?? '[]').length as number, id);

async function openTrash(page: Page) {
  if (await page.locator('.app.sidebar-open').count()) await page.locator('.scrim').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  return page.locator('.trash-list');
}

test('a deleted note goes to the trash: restored with its ink, or deleted forever after asking', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await newNote(page, 'Draft');
  if (await page.locator('.app.sidebar-open').count()) await page.locator('.scrim').click();
  await page.waitForTimeout(300);
  await drag(cdp, geo.areaX + 80, stripY(geo, 0), geo.areaX + 250, stripY(geo, 0));
  const draft = (await notes(page)).find((n) => n.title === 'Draft')!;
  await expect.poll(() => strokesOf(page, draft.id)).toBe(1);

  // Delete: no question, it moves to the trash and another note opens.
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Moved "Draft" to the trash');
  await expect(noteRow(page, 'Draft')).toHaveCount(0);
  await expect(page.locator('.title-input')).not.toHaveValue('Draft');
  expect((await notes(page)).find((n) => n.id === draft.id)?.deleted_at).toBeTruthy();
  expect(await strokesOf(page, draft.id)).toBe(1);
  // Not found by search either.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.locator('.search-input').fill('Draft');
  await expect(page.locator('.search-results')).not.toContainText('Draft');
  await page.keyboard.press('Escape');

  // Restore it from Settings > Data controls.
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1);
  await expect(trash.locator('li')).toContainText('Draft');
  await expect(trash.locator('li')).toContainText('from My Notebook · deleted for good in 30 days');
  await trash.getByRole('button', { name: 'Restore "Draft"' }).click();
  await expect(trash).toContainText('The trash is empty');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  await expect(noteRow(page, 'Draft')).toHaveCount(1);
  expect((await notes(page)).find((n) => n.id === draft.id)?.deleted_at).toBeFalsy();
  expect(await strokesOf(page, draft.id)).toBe(1);

  // Delete again, then delete forever: that asks, and cancelling keeps it.
  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await openTrash(page);
  await trash.getByRole('button', { name: 'Delete "Draft" forever' }).click();
  await page.locator('dialog.modal.small').getByRole('button', { name: 'Cancel' }).click();
  await expect(trash.locator('li')).toHaveCount(1);
  await trash.getByRole('button', { name: 'Delete "Draft" forever' }).click();
  await expect(page.locator('dialog.modal.small')).toContainText('cannot be undone');
  await page.locator('dialog.modal.small').getByRole('button', { name: 'Delete forever' }).click();
  await expect(trash).toContainText('The trash is empty');
  expect((await notes(page)).map((n) => n.id)).not.toContain(draft.id);
  expect(await strokesOf(page, draft.id)).toBe(0);
});

test('a deleted notebook goes to the trash with its notes and comes back with them; Empty trash clears it all', async ({ page }) => {
  await setup(page);
  await openSidebar(page);
  await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Old term');
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  await newNote(page, 'Lecture 1');
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.locator('.book-button')).toContainText('My Notebook');

  const trash = await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1);
  await expect(trash.locator('li')).toContainText('Old term');
  await expect(trash.locator('li')).toContainText('2 notes');
  await trash.getByRole('button', { name: 'Restore "Old term"' }).click();
  await expect(trash).toContainText('The trash is empty');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.book-open').click();
  await expect(page.locator('.book-button')).toContainText('Old term');
  await expect(noteRow(page, 'Lecture 1')).toHaveCount(1);

  // Delete the notebook and a note from the other one, then empty the trash.
  await newNote(page, 'Scrap');
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Scrap'), 'Delete');
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1); // the note deleted inside the notebook goes with it
  await trash.getByRole('button', { name: 'Empty trash' }).click();
  await page.locator('dialog.modal.small').getByRole('button', { name: 'Empty trash' }).click();
  await expect(trash).toContainText('The trash is empty');
  expect((await books(page)).map((b) => b.name)).toEqual(['My Notebook']);
  expect((await notes(page)).map((n) => n.title)).not.toContain('Lecture 1');
  expect((await notes(page)).map((n) => n.title)).not.toContain('Scrap');
});

test('what has been in the trash for 30 days is deleted for good when the app starts', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Ancient');
  await newNote(page, 'Recent');
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Ancient'), 'Delete');
  await rowAction(page, noteRow(page, 'Recent'), 'Delete');
  await expect.poll(async () => (await notes(page)).filter((n) => n.deleted_at).length).toBe(2);
  await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('lb-local-notes')!);
    for (const n of all) if (n.title === 'Ancient') n.deleted_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    localStorage.setItem('lb-local-notes', JSON.stringify(all));
  });
  await page.reload();
  await attachBoard(page);
  await expect.poll(async () => (await notes(page)).map((n) => n.title)).not.toContain('Ancient');
  expect((await notes(page)).map((n) => n.title)).toContain('Recent');
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1);
  await expect(trash.locator('li')).toContainText('Recent');
});

test('signed in: a deleted note is kept in the account, in the trash; without the database update, deleting asks and is permanent', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(db.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  await newNote(page, 'Cloud draft');
  await expect.poll(() => db.notes.length).toBe(2);
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Cloud draft'), 'Delete');
  await expect(page.locator('#toast')).toContainText('to the trash');
  await expect.poll(() => db.notes.find((n) => n.title === 'Cloud draft')?.deleted_at).toBeTruthy();

  // After a reload it is still in the trash, not in the sidebar.
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(noteRow(page, 'Cloud draft')).toHaveCount(0);
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toContainText('Cloud draft');
  await trash.getByRole('button', { name: 'Restore "Cloud draft"' }).click();
  await expect.poll(() => db.notes.find((n) => n.title === 'Cloud draft')?.deleted_at ?? null).toBeNull();
  await page.locator('.settings-close').click();

  // A database without the trash columns: deleting asks, then deletes for good.
  db.noTrash = true;
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Cloud draft'), 'Delete');
  await expect(page.locator('dialog[open] p')).toContainText('deleted permanently');
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => db.notes.map((n) => n.title)).not.toContain('Cloud draft');
});
