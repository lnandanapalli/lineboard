import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, setup, stripY } from './helpers';
import { mockSupabase, USER_ID } from './mockSupabase';

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
  await page.getByRole('button', { name: 'New note', exact: true }).click();
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
  await page.locator('dialog[open]').getByRole('button', { name: 'Move to trash' }).click();
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
const dlg = (page: Page) => page.locator('dialog.modal.small[open]');

async function openTrash(page: Page) {
  await openSidebar(page);
  await page.locator('.trash-btn').click();
  return page.locator('.trash-list');
}

async function newNotebook(page: Page, name: string) {
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await dlg(page).locator('.dlg-input').fill(name);
  await dlg(page).getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
}

/** What another tab (or device) would do: change the saved notebooks behind this one's back. */
const elsewhere = (page: Page, fn: (books: (N & { name: string })[], notes: N[]) => void) =>
  page.evaluate((src) => {
    const books = JSON.parse(localStorage.getItem('lb-local-notebooks') ?? '[]');
    const notes = JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]');
    new Function('books', 'notes', `(${src})(books, notes)`)(books, notes);
    localStorage.setItem('lb-local-notebooks', JSON.stringify(books));
    localStorage.setItem('lb-local-notes', JSON.stringify(notes));
  }, fn.toString());

test('deleting a note asks, then moves it to the Trash notebook; restoring asks which notebook it goes into', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await newNotebook(page, 'Physics');
  await newNote(page, 'Draft');
  if (await page.locator('.app.sidebar-open').count()) await page.locator('.scrim').click();
  await page.waitForTimeout(300);
  await drag(cdp, geo.areaX + 80, stripY(geo, 0), geo.areaX + 250, stripY(geo, 0));
  const draft = (await notes(page)).find((n) => n.title === 'Draft')!;
  await expect.poll(() => strokesOf(page, draft.id)).toBe(1);

  // Asks first; cancelling keeps it.
  await openSidebar(page);
  await expect(page.locator('.trash-btn')).toHaveAttribute('aria-label', 'Trash, empty');
  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await expect(dlg(page)).toContainText('Move to trash?');
  await dlg(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(noteRow(page, 'Draft')).toHaveCount(1);

  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('#toast')).toContainText('Moved "Draft" to the trash');
  await expect(noteRow(page, 'Draft')).toHaveCount(0);
  await expect(page.locator('.title-input')).not.toHaveValue('Draft');
  // A move like any other: into the Trash notebook, ink kept.
  const moved = (await notes(page)).find((n) => n.id === draft.id)!;
  expect(moved.notebook_id).toBe('trash');
  expect(moved.deleted_at).toBeTruthy();
  expect(await strokesOf(page, draft.id)).toBe(1);
  await expect(page.locator('.trash-btn')).toHaveAttribute('aria-label', 'Trash, 1 item');
  // The trash is not a notebook to pick, and search does not find what is in it.
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await expect(page.locator('.book-list li', { hasText: 'Trash' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.locator('.search-input').fill('Draft');
  await expect(page.locator('.search-results')).not.toContainText('Draft');
  await page.keyboard.press('Escape');

  // The sidebar's Trash opens it; Restore asks which notebook, from the ones there are.
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1);
  await expect(trash.locator('li')).toContainText('deleted for good in 30 days');
  await trash.getByRole('button', { name: 'Restore "Draft"' }).click();
  await expect(dlg(page)).toContainText('Restore note');
  await expect(dlg(page).locator('select option')).toHaveText(['Physics', 'My Notebook']);
  await dlg(page).locator('select').selectOption({ label: 'My Notebook' });
  await dlg(page).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#toast')).toContainText('Restored "Draft" to "My Notebook"');
  await expect(trash).toContainText('The trash is empty');
  const back = (await notes(page)).find((n) => n.id === draft.id)!;
  expect(back.notebook_id).not.toBe('trash');
  expect(back.deleted_at).toBeFalsy();
  expect((await books(page)).find((b) => b.id === back.notebook_id)?.name).toBe('My Notebook');
  expect(await strokesOf(page, draft.id)).toBe(1);

  // Delete again, then delete forever: that asks too.
  await page.locator('.settings-close').click();
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'My Notebook' }).locator('.book-open').click();
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  await openTrash(page);
  await trash.getByRole('button', { name: 'Delete "Draft" forever' }).click();
  await expect(dlg(page)).toContainText('cannot be undone');
  await dlg(page).getByRole('button', { name: 'Delete forever' }).click();
  await expect(trash).toContainText('The trash is empty');
  expect((await notes(page)).map((n) => n.id)).not.toContain(draft.id);
  expect(await strokesOf(page, draft.id)).toBe(0);
});

test('restoring into a notebook deleted elsewhere meanwhile fails and says so; the note stays in the trash', async ({ page }) => {
  await setup(page);
  await newNotebook(page, 'Physics');
  await newNote(page, 'Draft');
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Draft'), 'Delete');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  const trash = await openTrash(page);
  await trash.getByRole('button', { name: 'Restore "Draft"' }).click();
  await dlg(page).locator('select').selectOption({ label: 'Physics' });
  // While the question is open, another tab deletes "Physics" for good.
  await elsewhere(page, (books, notes) => {
    const id = books.find((b) => b.name === 'Physics')!.id;
    books.splice(books.findIndex((b) => b.id === id), 1);
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].notebook_id === id) notes.splice(i, 1);
  });
  await dlg(page).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#toast')).toContainText('Restore failed. That notebook no longer exists');
  await expect(trash.locator('li')).toContainText('Draft');
  expect((await notes(page)).find((n) => n.title === 'Draft')?.notebook_id).toBe('trash');
  // The app caught up: it left "Physics", which is gone, for a notebook that is there.
  await page.locator('.settings-close').click();
  await expect(page.locator('.book-button')).toContainText('My Notebook');

  // Same if it is moved to the trash elsewhere rather than deleted.
  await newNotebook(page, 'Chemistry');
  await openTrash(page);
  await trash.getByRole('button', { name: 'Restore "Draft"' }).click();
  await dlg(page).locator('select').selectOption({ label: 'Chemistry' });
  await elsewhere(page, (books) => {
    books.find((b) => b.name === 'Chemistry')!.deleted_at = new Date().toISOString();
  });
  await dlg(page).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#toast')).toContainText('Restore failed. That notebook no longer exists');
  expect((await notes(page)).find((n) => n.title === 'Draft')?.notebook_id).toBe('trash');
});

test('a deleted notebook goes to the trash whole: its notes are listed under it, and it comes back only whole', async ({ page }) => {
  await setup(page);
  await newNotebook(page, 'Old term');
  await page.locator('.title-input').fill('Lecture 1');
  await page.locator('.title-input').press('Enter');
  await newNote(page, 'Lecture 2');
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dlg(page)).toContainText('Move notebook to trash?');
  await expect(dlg(page)).toContainText('its 2 notes');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('.book-button')).toContainText('My Notebook');

  const trash = await openTrash(page);
  const row = trash.locator('li.trash-book');
  await expect(row).toContainText('Old term');
  await expect(row).toContainText('2 notes');
  // Its notes are shown under it, with nothing to do to them one by one.
  await expect(row.locator('.trash-inside li')).toHaveText(['Lecture 2', 'Lecture 1']);
  await expect(row.locator('.trash-inside button')).toHaveCount(0);
  await expect(trash.getByRole('button', { name: /Restore "Lecture/ })).toHaveCount(0);

  await trash.getByRole('button', { name: 'Restore "Old term"' }).click();
  await expect(page.locator('#toast')).toContainText('Restored "Old term"');
  await expect(trash).toContainText('The trash is empty');
  await page.locator('.settings-close').click();
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.book-open').click();
  await openSidebar(page);
  await expect(noteRow(page, 'Lecture 1')).toHaveCount(1);
  await expect(noteRow(page, 'Lecture 2')).toHaveCount(1);

  // A note in the trash and a notebook in the trash: Empty trash deletes both for good.
  await rowAction(page, noteRow(page, 'Lecture 2'), 'Delete');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Old term' }).locator('.more-btn').click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  await openTrash(page);
  await expect(trash.locator('.archived-items > li')).toHaveCount(2);
  await trash.getByRole('button', { name: 'Empty trash' }).click();
  await dlg(page).getByRole('button', { name: 'Empty trash' }).click();
  await expect(trash).toContainText('The trash is empty');
  expect((await books(page)).map((b) => b.name).sort()).toEqual(['My Notebook', 'Trash']);
  expect((await notes(page)).map((n) => n.title)).not.toContain('Lecture 1');
  expect((await notes(page)).map((n) => n.title)).not.toContain('Lecture 2');
});

test('what has been in the trash for 30 days is deleted for good when the app starts', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Ancient');
  await newNote(page, 'Recent');
  await openSidebar(page);
  for (const t of ['Ancient', 'Recent']) {
    await rowAction(page, noteRow(page, t), 'Delete');
    await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  }
  await expect.poll(async () => (await notes(page)).filter((n) => n.notebook_id === 'trash').length).toBe(2);
  await elsewhere(page, (_books, notes) => {
    notes.find((n) => n.title === 'Ancient')!.deleted_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
  });
  await page.reload();
  await attachBoard(page);
  await expect.poll(async () => (await notes(page)).map((n) => n.title)).not.toContain('Ancient');
  expect((await notes(page)).map((n) => n.title)).toContain('Recent');
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toHaveCount(1);
  await expect(trash.locator('li')).toContainText('Recent');
});

test('actions on a note or notebook changed in another tab fail with a clear message, and the app catches up', async ({ page }) => {
  await setup(page);
  await newNotebook(page, 'Physics');
  await newNote(page, 'Waves');
  await newNote(page, 'Optics');

  // Renaming a note another tab deleted.
  await elsewhere(page, (_books, notes) => {
    notes.splice(notes.findIndex((n) => n.title === 'Waves'), 1);
  });
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Waves'), 'Rename');
  await dlg(page).locator('.dlg-input').fill('Sound');
  await dlg(page).getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('#toast')).toContainText('Rename failed. That note no longer exists');
  await expect(noteRow(page, 'Waves')).toHaveCount(0); // the list caught up
  await expect(noteRow(page, 'Sound')).toHaveCount(0);

  // Moving a note into a notebook another tab moved to the trash.
  await newNotebook(page, 'Chemistry');
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Physics' }).locator('.book-open').click();
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Optics'), 'Move to notebook');
  await elsewhere(page, (books) => {
    books.find((b) => b.name === 'Chemistry')!.deleted_at = new Date().toISOString();
  });
  await dlg(page).locator('select').selectOption({ label: 'Chemistry' });
  await dlg(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('#toast')).toContainText('Move failed. That notebook no longer exists');
  expect((await notes(page)).find((n) => n.title === 'Optics')?.notebook_id).toBe((await books(page)).find((b) => b.name === 'Physics')!.id);

  // Making a note in the open notebook, which another tab deleted: the app moves to one that exists.
  await elsewhere(page, (books, notes) => {
    const id = books.find((b) => b.name === 'Physics')!.id;
    books.splice(books.findIndex((b) => b.id === id), 1);
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].notebook_id === id) notes.splice(i, 1);
  });
  await openSidebar(page);
  await page.getByRole('button', { name: 'New note' }).click();
  await dlg(page).getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('#toast')).toContainText('That notebook no longer exists');
  await expect(page.locator('.book-button')).toContainText('My Notebook');
});

test('coming back to the tab picks up notes and notebooks changed elsewhere', async ({ page }) => {
  await setup(page);
  await newNote(page, 'Kept');
  await newNote(page, 'Removed elsewhere');
  await elsewhere(page, (books, notes) => {
    notes.find((n) => n.title === 'Removed elsewhere')!.notebook_id = 'trash';
    const now = new Date().toISOString();
    books.push({ id: 'b-elsewhere', name: 'Made elsewhere', created_at: now, updated_at: now } as never);
  });
  await page.waitForTimeout(5100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await openSidebar(page);
  await expect(noteRow(page, 'Removed elsewhere')).toHaveCount(0);
  await expect(page.locator('.title-input')).not.toHaveValue('Removed elsewhere');
  await expect(page.locator('.trash-btn')).toHaveAttribute('aria-label', 'Trash, 1 item');
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await expect(page.locator('.book-list li', { hasText: 'Made elsewhere' })).toHaveCount(1);
});

test('signed in: the trash is a notebook in the account; another device deleting the target notebook makes a restore fail; an older database deletes for good', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(db.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  const trashId = USER_ID.slice(0, 14) + '8' + USER_ID.slice(15);
  await expect.poll(() => db.notebooks.find((b) => b.id === trashId)?.name).toBe('Trash');
  await newNotebook(page, 'Physics');
  await newNote(page, 'Cloud draft');
  await openSidebar(page);
  await rowAction(page, noteRow(page, 'Cloud draft'), 'Delete');
  await dlg(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect.poll(() => db.notes.find((n) => n.title === 'Cloud draft')?.notebook_id).toBe(trashId);

  // After a reload it is still in the trash.
  await page.reload();
  await attachBoard(page);
  const trash = await openTrash(page);
  await expect(trash.locator('li')).toContainText('Cloud draft');
  await trash.getByRole('button', { name: 'Restore "Cloud draft"' }).click();
  await dlg(page).locator('select').selectOption({ label: 'Physics' });
  // Another device moves "Physics" to the trash meanwhile: the database refuses the move.
  db.notebooks.find((b) => b.name === 'Physics')!.deleted_at = new Date().toISOString();
  await dlg(page).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#toast')).toContainText('Restore failed. That notebook no longer exists');
  expect(db.notes.find((n) => n.title === 'Cloud draft')?.notebook_id).toBe(trashId);
  // Into one that is there, it works.
  await trash.getByRole('button', { name: 'Restore "Cloud draft"' }).click();
  await expect(dlg(page).locator('select option')).toHaveText(['My Notebook']);
  await dlg(page).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => db.notes.find((n) => n.title === 'Cloud draft')?.notebook_id).toBe(USER_ID);
  await page.locator('.settings-close').click();

  // A database without the trash columns: deleting asks, then deletes for good.
  db.noTrash = true;
  await page.reload();
  await attachBoard(page);
  await openSidebar(page);
  await expect(page.locator('.trash-btn')).toBeHidden();
  await rowAction(page, noteRow(page, 'Cloud draft'), 'Delete');
  await expect(dlg(page).locator('p')).toContainText('deleted permanently');
  await dlg(page).getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => db.notes.map((n) => n.title)).not.toContain('Cloud draft');
});
