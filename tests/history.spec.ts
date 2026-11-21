import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, setup, stripY, type Geo } from './helpers';
import { mockSupabase } from './mockSupabase';
import { diff, restorePlan, toPrune, type SnapStroke, type VersionMeta } from '../src/history';

/** Version history: versions saved as you write, browsed on the board, restored or copied. */

type V = { id: string; note_id: string; kind: string; name: string | null; restored_from: string | null; created_at: string };

/** Versions kept on this device (local mode), newest first. */
const localVersions = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<V[]>((resolve, reject) => {
        const req = indexedDB.open('lineboard-local-history', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('versions', { keyPath: 'id' }).createIndex('note_id', 'note_id');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('versions').objectStore('versions').getAll();
          all.onsuccess = () => {
            req.result.close();
            resolve((all.result as V[]).map(({ id, note_id, kind, name, restored_from, created_at }) => ({ id, note_id, kind, name, restored_from, created_at })).sort((a, b) => b.created_at.localeCompare(a.created_at)));
          };
        };
      }),
  );

const notes = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]') as { id: string; title: string }[]).map((n) => ({ ...n, strokes: JSON.parse(localStorage.getItem('lb-local-strokes-' + n.id) ?? '[]') as { points: number[] }[] })));

const openSidebar = async (page: Page) => {
  if (!(await page.locator('.app.sidebar-open').count())) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.waitForTimeout(300);
  }
};

/** Open another note from the list (leaving a note saves its version). */
async function openNote(page: Page, title: string) {
  await openSidebar(page);
  await page.locator('.note-open', { hasText: title }).click();
  await page.locator(`.canvas-area[data-note]:not([aria-busy])`).waitFor();
  if (await page.locator('.app.sidebar-open').count()) {
    await page.locator('.scrim').click();
    await page.waitForTimeout(300);
  }
}

async function newNote(page: Page, title: string) {
  await openSidebar(page);
  await page.getByRole('button', { name: 'New note' }).click();
  await page.locator('dialog[open] .dlg-input').fill(title);
  await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor();
  if (await page.locator('.app.sidebar-open').count()) {
    await page.locator('.scrim').click();
    await page.waitForTimeout(300);
  }
}

/** A short line. Reopening a note unlocks the strip after its ink, so later lines go lower. */
async function draw(cdp: Awaited<ReturnType<typeof setup>>['cdp'], geo: Geo, x: number, strip = 0) {
  const y = stripY(geo, strip);
  await drag(cdp, geo.areaX + x, y, geo.areaX + x + 100, y);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Version history' });

test('versions are saved as you go; an old one can be viewed, restored (as a new version) and the restore undone', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const first = (await notes(page))[0];
  await draw(cdp, geo, 50);
  await expect.poll(async () => (await notes(page))[0].strokes.length).toBe(1);

  // Leaving the note saves a version of it.
  await newNote(page, 'Other');
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === first.id).length).toBe(1);
  await openNote(page, first.title);
  await draw(cdp, geo, 300, 1);
  await openNote(page, 'Other');
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === first.id).length).toBe(2);
  await openNote(page, first.title);

  await page.getByRole('button', { name: 'Version history' }).click();
  const list = panel(page).getByRole('option');
  await expect(list).toHaveCount(3); // current, and two versions
  await expect(list.first()).toContainText('Current version');
  // Read-only while looking at history: drawing does nothing.
  await draw(cdp, geo, 600, 2);
  await expect.poll(async () => (await notes(page)).find((n) => n.id === first.id)!.strokes.length).toBe(2);

  // The oldest version: one line.
  await list.nth(2).click();
  await panel(page).getByRole('button', { name: 'Restore this version' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Restore' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(async () => (await notes(page)).find((n) => n.id === first.id)!.strokes.length).toBe(1);
  // Nothing was deleted: the restore is a new version on top.
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === first.id).length).toBe(3);
  const after = (await localVersions(page)).filter((v) => v.note_id === first.id);
  expect(after[0].kind).toBe('restore');
  expect(after[0].restored_from).toBe(after[2].created_at);

  // A restore is one step to undo.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await notes(page)).find((n) => n.id === first.id)!.strokes.length).toBe(2);

  // The history shows the restore, with where it came from.
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(panel(page).getByRole('option').nth(1)).toContainText('Restored from');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
});

test('a copy of a version is a new note: fresh, or with the history up to that version', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const first = (await notes(page))[0];
  await draw(cdp, geo, 50);
  await newNote(page, 'Other');
  await openNote(page, first.title);
  await draw(cdp, geo, 300, 1);
  await openNote(page, 'Other');
  await openNote(page, first.title);
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === first.id).length).toBe(2);

  // Fresh copy of the older version.
  await page.getByRole('button', { name: 'Version history' }).click();
  await panel(page).getByRole('option').nth(2).click();
  await panel(page).getByRole('button', { name: 'Make a copy' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Fresh copy');
  await page.locator('dialog').getByRole('button', { name: 'Make a copy' }).click();
  await expect(page.locator('.title-input')).toHaveValue('Fresh copy');
  const fresh = (await notes(page)).find((n) => n.title === 'Fresh copy')!;
  expect(fresh.strokes).toHaveLength(1);
  // Starting fresh: only the first version, made when it opened.
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === fresh.id).length).toBe(1);

  // Copy of the newest version, with its history.
  await openNote(page, first.title);
  await page.getByRole('button', { name: 'Version history' }).click();
  await panel(page).getByRole('option').nth(1).click();
  await panel(page).getByRole('button', { name: 'Make a copy' }).click();
  await page.locator('dialog[open] .dlg-input').fill('With history');
  await page.locator('dialog').getByText('Keep the history up to this version').click();
  await page.locator('dialog').getByRole('button', { name: 'Make a copy' }).click();
  await expect(page.locator('.title-input')).toHaveValue('With history');
  const kept = (await notes(page)).find((n) => n.title === 'With history')!;
  expect(kept.strokes).toHaveLength(2);
  const mine = (await localVersions(page)).filter((v) => v.note_id === first.id);
  const theirs = (await localVersions(page)).filter((v) => v.note_id === kept.id);
  expect(theirs.map((v) => v.created_at)).toEqual(mine.map((v) => v.created_at));
  // The original is untouched.
  expect((await notes(page)).find((n) => n.id === first.id)!.strokes).toHaveLength(2);
});

test('naming versions: the current one, and an older one; named versions show in "Only named versions"', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await draw(cdp, geo, 50);
  await page.getByRole('button', { name: 'Version history' }).click();
  await panel(page).getByRole('button', { name: 'Name current version' }).click();
  await page.locator('dialog[open] .dlg-input').fill('First draft');
  await page.locator('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByRole('option', { name: /First draft/ })).toBeVisible();
  await panel(page).getByText('Only named versions').click();
  await expect(panel(page).getByRole('option')).toHaveCount(2);
  const v = (await localVersions(page))[0];
  expect(v.name).toBe('First draft');
  await panel(page).getByRole('option', { name: /First draft/ }).click();
  await panel(page).getByRole('button', { name: 'Remove name' }).click();
  await expect(panel(page).getByRole('option')).toHaveCount(1);
  expect((await localVersions(page))[0].name).toBeNull();
});

test('signed in: versions are stored in the account; without the database update, history says what is needed', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill(db.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Wait for the signed-in board (loading /app again here could beat the sign-in and open device-only mode).
  const { cdp, geo } = await attachBoard(page);
  await draw(cdp, geo, 50);
  await expect.poll(() => db.strokes.length).toBe(1);
  await page.getByRole('button', { name: 'Version history' }).click();
  await panel(page).getByRole('button', { name: 'Name current version' }).click();
  await page.locator('dialog[open] .dlg-input').fill('Saved');
  await page.locator('dialog').getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => (db.versions ?? []).length).toBe(1);
  const row = db.versions![0];
  expect(row.name).toBe('Saved');
  expect(typeof row.data).toBe('string');
  expect(row.data_enc).toBeNull();
  expect(row.size).toBe((row.data as string).length);
  await page.keyboard.press('Escape');

  db.noHistory = true;
  await page.reload();
  await setup(page);
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(page.locator('#toast')).toContainText('database update');
});

/** Entries of a zip (stored or deflated). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const packed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const start = i + 30 + nameLen + buf.readUInt16LE(i + 28);
    out.set(buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'), method === 8 ? inflateRawSync(buf.subarray(start, start + packed)) : buf.subarray(start, start + packed));
    i = start + packed;
  }
  return out;
}

async function nameCurrent(page: Page, name: string) {
  await page.getByRole('button', { name: 'Version history' }).click();
  await panel(page).getByRole('button', { name: 'Name current version' }).click();
  await page.locator('dialog[open] .dlg-input').fill(name);
  await page.locator('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(panel(page).getByRole('option', { name: new RegExp(name) })).toBeVisible();
  await page.keyboard.press('Escape');
}

test('"Export all" keeps the history and importing it brings the versions back; a single note is exported without it', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const first = (await notes(page))[0];
  await draw(cdp, geo, 50);
  await nameCurrent(page, 'One line');
  await draw(cdp, geo, 300);
  await nameCurrent(page, 'Two lines');

  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Data controls' }).click();
  await page.getByRole('button', { name: 'Export all notes (.lbd)' }).click();
  const file = readFileSync((await (await wait).path())!);
  await page.locator('.settings-close').click();
  const lbd = unzip(file);
  const note = JSON.parse(lbd.get('notes/0001.json')!.toString());
  expect(note.history.map((v: { name: string }) => v.name)).toEqual(['One line', 'Two lines']); // oldest first
  expect(note.history[0].strokes).toHaveLength(1);
  expect(note.history[1].strokes).toHaveLength(2);

  // A single note, shared: its content only.
  const one = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share or export', exact: true }).click();
  await page.getByRole('button', { name: /^Lineboard file/ }).click();
  const single = JSON.parse(unzip(readFileSync((await (await one).path())!)).get('notes/0001.json')!.toString());
  expect(single.history).toBeUndefined();

  // Import the backup: a new note, with the two versions and their names and dates.
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.waitForTimeout(300);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await (await chooser).setFiles({ name: 'backup.lbd', mimeType: 'application/octet-stream', buffer: file });
  await expect(page.locator('#toast')).toContainText('Imported');
  const copy = (await notes(page)).find((n) => n.id !== first.id)!;
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === copy.id).map((v) => v.name)).toEqual(['Two lines', 'One line']);
  const mine = (await localVersions(page)).filter((v) => v.note_id === first.id).map((v) => v.created_at);
  expect((await localVersions(page)).filter((v) => v.note_id === copy.id).map((v) => v.created_at)).toEqual(mine);
});

test('with encryption on, versions and their names are stored encrypted (old ones too), and still open here', async ({ page }) => {
  test.setTimeout(60_000);
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const { cdp, geo } = await attachBoard(page);
  await draw(cdp, geo, 50);
  await nameCurrent(page, 'Before encryption');
  await expect.poll(() => db.versions?.[0]?.data).toBeTruthy();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Encryption' }).click();
  await page.getByRole('switch', { name: 'End-to-end encryption' }).click();
  const confirm = page.locator('dialog.confirm-dialog');
  await confirm.locator('input[type=password]').fill('secret123');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  const dlg = page.locator('dialog.enc-wizard');
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await dlg.locator('input[type=password]').nth(0).fill('correct horse battery');
  await dlg.locator('input[type=password]').nth(1).fill('correct horse battery');
  await dlg.getByRole('button', { name: 'Create keys' }).click();
  const key = (await dlg.locator('.recovery-key').textContent())!;
  await dlg.getByLabel('Last 4 characters of the recovery key').fill(key.slice(-4));
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('button', { name: 'Continue' }).click();
  await expect(dlg).toContainText('Your notes are encrypted', { timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.locator('.settings-close').click();

  // The version made before is now encrypted, name included.
  const old = db.versions![0];
  expect(old.data).toBeNull();
  expect(old.name).toBeNull();
  expect(String(old.data_enc)).not.toContain('Before');
  expect(old.name_enc).toBeTruthy();

  await draw(cdp, geo, 300);
  await nameCurrent(page, 'After encryption');
  await expect.poll(() => db.versions!.length).toBe(2);
  expect(db.versions!.every((v) => v.data == null && v.name == null && !!v.data_enc && !!v.name_enc)).toBe(true);
  // Readable on this device: the names show, and an old version opens.
  await page.getByRole('button', { name: 'Version history' }).click();
  await expect(panel(page).getByRole('option', { name: /Before encryption/ })).toBeVisible();
  await panel(page).getByRole('option', { name: /Before encryption/ }).click();
  await expect(panel(page).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
  await expect(page.locator('#toast.show.error')).toHaveCount(0);
});

test('signing in from guest mode brings the history along, even for a note erased to empty', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Try it without an account' }).click();
  const { cdp, geo } = await attachBoard(page);
  await draw(cdp, geo, 50);
  await nameCurrent(page, 'Guest draft');
  // Erase it all: the note has no ink left, only its history.
  await page.keyboard.press('e');
  await drag(cdp, geo.areaX + 40, stripY(geo, 0), geo.areaX + 170, stripY(geo, 0));
  await expect.poll(async () => (await notes(page))[0].strokes.length).toBe(0);
  await page.locator('.toolbar .signin-save').click();
  await page.getByPlaceholder('Email').fill('friend@example.com');
  await page.getByPlaceholder('Password').fill('secret123');
  await page.locator('form.auth-form button[type=submit]').click();
  await attachBoard(page);
  await expect.poll(() => (db.versions ?? []).filter((v) => v.name).map((v) => v.name)).toEqual(['Guest draft']);
  expect(db.versions![0].note_id).toBe(db.notes[0].id);
});

// ---------------- the rules, without a browser ----------------

const pen = (x: number): SnapStroke => ({ tool: 'pen', color: '#111827', width: 3, points: [x, 10, 0.5, x + 10, 10, 0.5] });

test('diff and restore plan compare strokes by what they are', () => {
  const a = pen(1), b = pen(2), c = pen(3);
  const d = diff([a, b], [b, c]);
  expect([...d.added]).toEqual([1]);
  expect(d.removed).toEqual([a]);
  // A duplicate counts as a stroke of its own.
  expect([...diff([a], [a, a]).added]).toEqual([1]);
  const current = [a, b].map((s, i) => ({ ...s, id: 'id' + i, note_id: 'n' }));
  // Shared from the start: kept. From the first difference on: replaced.
  const plan = restorePlan(current, [a, c]);
  expect(plan.remove.map((s) => s.id)).toEqual(['id1']);
  expect(plan.add).toEqual([c]);
  // Layering is kept: restoring [red, blue] over [blue] must not leave red on top.
  const red = pen(10), blue = pen(20);
  const p2 = restorePlan([{ ...blue, id: 'b', note_id: 'n' }], [red, blue]);
  expect(p2.remove.map((s) => s.id)).toEqual(['b']);
  expect(p2.add).toEqual([red, blue]);
});

test('old unnamed versions thin out; named ones and the newest are kept', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const at = (ms: number, name: string | null = null, i = 0): VersionMeta => ({ id: `${ms}-${i}`, note_id: 'n', created_at: new Date(now - ms).toISOString(), kind: 'auto', name, restored_from: null });
  const H = 3_600_000, D = 24 * H;
  const vs = [
    at(5 * 60_000), // today: kept
    at(2 * H), // today: kept
    at(2 * D - 60_000), at(2 * D, null, 1), // same hour, two days ago: the newer one kept
    at(10 * D - H), at(10 * D, null, 1), // same day, ten days ago: the newer one kept
    at(100 * D), // too old: removed
    at(200 * D, 'Milestone'), // named: kept
  ];
  const gone = toPrune(vs, now).map((v) => v.id);
  expect(gone.sort()).toEqual([vs[3].id, vs[5].id, vs[6].id].sort());
  // The newest always stays, however old.
  expect(toPrune([at(400 * D)], now)).toEqual([]);
  // At most `cap` in all: the oldest unnamed go first.
  const many = Array.from({ length: 10 }, (_, i) => at(i * 60_000, null, i));
  expect(toPrune(many, now, 4).map((v) => v.id)).toEqual(many.slice(4).map((v) => v.id));
});

test('Clear page erases everything after asking; it is one undo step and the page before stays in history', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  const first = (await notes(page))[0];
  const saved = async () => (await notes(page)).find((n) => n.id === first.id)!.strokes.length;
  await draw(cdp, geo, 50);
  await draw(cdp, geo, 300);
  await expect.poll(saved).toBe(2);
  expect((await localVersions(page)).filter((v) => v.note_id === first.id)).toHaveLength(0);

  const clear = page.getByRole('button', { name: 'Clear page' });
  const dlg = page.locator('dialog[open]');
  // Cancelling keeps everything.
  await clear.click();
  await expect(dlg).toContainText('Clear this page?');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(200);
  expect(await saved()).toBe(2);

  await clear.click();
  await dlg.getByRole('button', { name: 'Clear page' }).click();
  await expect.poll(saved).toBe(0);
  // The page as it was is now a version.
  await expect.poll(async () => (await localVersions(page)).filter((v) => v.note_id === first.id).length).toBe(1);

  // One undo brings it all back.
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(saved).toBe(2);

  // An empty page has nothing to clear: no question asked.
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(saved).toBe(0);
  await clear.click();
  await expect(dlg).toHaveCount(0);
});
