import { readFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { attachBoard, drag, PEN, send, setup, stripY, tp } from './helpers';
import { mockSupabase } from './mockSupabase';

/** Lineboard files (.lbd): export a note, a notebook or everything; import them back, alone or zipped. */

const PNG = readFileSync(new URL('./fixture.png', import.meta.url));

// ---------------- zip helpers (Node side) ----------------

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const packed = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extra;
    out.set(name, method === 8 ? inflateRawSync(buf.subarray(start, start + packed)) : buf.subarray(start, start + packed));
    i = start + packed;
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A zip as other tools make it (deflated entries). */
function makeZip(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [n, data] of entries) {
    const name = Buffer.from(n);
    const body = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

/** An .lbd made by hand, for the import checks. */
function lbd(notes: { title: string; strokes: unknown[] }[], extra: Record<string, unknown> = {}, pictures: [string, Buffer][] = []) {
  const manifest = { format: 'lineboard', version: 1, notebooks: [{ name: 'From a file', notes: notes.map((_, i) => ({ file: `notes/${i}.json` })) }], ...extra };
  return makeZip([['lineboard.json', Buffer.from(JSON.stringify(manifest))], ...notes.map((n, i): [string, Buffer] => [`notes/${i}.json`, Buffer.from(JSON.stringify(n))]), ...pictures]);
}

// ---------------- app helpers ----------------

type S = { tool: string; text?: string; color: string; width: number; points: number[]; dash?: string; font?: Record<string, unknown> };
const localState = (page: Page) =>
  page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('lb-local-notes') ?? '[]') as { id: string; title: string; notebook_id: string }[];
    const books = JSON.parse(localStorage.getItem('lb-local-notebooks') ?? '[]') as { id: string; name: string }[];
    const strokes = (id: string) => JSON.parse(localStorage.getItem('lb-local-strokes-' + id) ?? '[]') as S[];
    return { books, notes: notes.map((n) => ({ ...n, strokes: strokes(n.id) })) };
  });

const openSidebar = async (page: Page) => {
  if (!(await page.locator('.app.sidebar-open').count())) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.waitForTimeout(300); // let it slide in
  }
};

async function importBytes(page: Page, name: string, buffer: Buffer) {
  await openSidebar(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
}

async function downloaded(page: Page, click: () => Promise<void>) {
  const wait = page.waitForEvent('download');
  await click();
  const d = await wait;
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

/** A note with a pen line, a dashed shape, a formatted text box and a picture. */
async function richNote(page: Page, title: string) {
  const { cdp, geo } = await setup(page);
  await page.locator('.title-input').fill(title);
  await page.locator('.title-input').press('Enter');
  const y = stripY(geo, 0);
  await drag(cdp, geo.areaX + 80, y, geo.areaX + 200, y);
  await page.locator('.shape-btn').click();
  await page.getByRole('radio', { name: 'Dashed' }).click();
  await page.locator('.shape-grid').getByRole('radio', { name: 'Rectangle', exact: true }).click();
  await drag(cdp, geo.areaX + 250, y - 20, geo.areaX + 350, y + 20);
  await page.keyboard.press('t');
  await send(cdp, 'touchStart', [tp(geo.areaX + 420, y, PEN, 3)]);
  await send(cdp, 'touchEnd', []);
  await page.getByRole('toolbar', { name: 'Text format' }).getByRole('radio', { name: 'Serif' }).click();
  await page.keyboard.type('Hello file');
  await page.keyboard.press('Escape');
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await localState(page)).notes.find((n) => n.title === title)?.strokes.length).toBe(4);
  return { cdp, geo };
}

const shape = (strokes: S[]) => strokes.map((s) => ({ tool: s.tool, color: s.tool === 'image' ? 'img' : s.color, width: s.width, points: s.points, text: s.tool === 'text' ? s.text : undefined, dash: s.dash, font: s.font })).sort((a, b) => a.tool.localeCompare(b.tool));

// ---------------- tests ----------------

test('export a note as .lbd and import it back: everything returns, as a new note', async ({ page }) => {
  await richNote(page, 'Lecture 1');
  const before = (await localState(page)).notes.find((n) => n.title === 'Lecture 1')!;
  // The toolbar's export menu offers a picture or a Lineboard file.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('.export-menu')).toContainText('Picture (.png)');
  const file = await downloaded(page, () => page.getByRole('button', { name: /Lineboard file/ }).click());
  expect(file.name).toBe('Lecture 1.lbd');
  const parts = unzip(file.bytes);
  const manifest = JSON.parse(parts.get('lineboard.json')!.toString());
  expect(manifest).toMatchObject({ format: 'lineboard', version: 1, notebooks: [{ name: 'My Notebook', notes: [{ file: 'notes/0001.json' }] }] });
  const note = JSON.parse(parts.get('notes/0001.json')!.toString());
  expect(note.title).toBe('Lecture 1');
  expect(note.strokes.find((s: { tool: string }) => s.tool === 'image').picture).toMatch(/^pictures\/.+\.png$/);
  expect(JSON.stringify(note)).not.toContain('"id"'); // ids are not stored

  await importBytes(page, file.name, file.bytes);
  await expect(page.locator('#toast')).toContainText('Imported “Lecture 1”');
  const after = await localState(page);
  const copies = after.notes.filter((n) => n.title === 'Lecture 1');
  expect(copies).toHaveLength(2); // a new note; the original is untouched
  const copy = copies.find((n) => n.id !== before.id)!;
  expect(shape(copy.strokes)).toEqual(shape(before.strokes));
  expect(copy.strokes.find((s) => s.tool === 'image')!.text).not.toBe(before.strokes.find((s) => s.tool === 'image')!.text); // its own picture
  await expect(page.locator('.title-input')).toHaveValue('Lecture 1'); // the imported note is open
});

test('export a notebook, delete it, and import it: the notebook comes back with its notes', async ({ page }) => {
  const { cdp, geo } = await setup(page);
  await drag(cdp, geo.areaX + 80, stripY(geo, 0), geo.areaX + 200, stripY(geo, 0));
  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('dialog[open] input.dlg-input').fill('Physics');
  await page.locator('dialog[open]').getByRole('button', { name: 'Create' }).click();
  await page.locator('.title-input').fill('Waves');
  await page.locator('.title-input').press('Enter');
  await page.locator('.canvas-area[data-note]:not([aria-busy])').waitFor(); // the new notebook's note has loaded
  if (await page.locator('.app.sidebar-open').count()) {
    await page.locator('.scrim').click();
    await page.waitForTimeout(300); // the sidebar slides away
  }
  await drag(cdp, geo.areaX + 80, stripY(geo, 0), geo.areaX + 300, stripY(geo, 0));
  await expect.poll(async () => (await localState(page)).notes.find((n) => n.title === 'Waves')?.strokes.length).toBe(1);
  await openSidebar(page);
  await page.getByRole('button', { name: 'New note' }).click();
  await page.locator('dialog[open] input.dlg-input').fill('Optics');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await localState(page)).notes.filter((n) => n.title === 'Waves' || n.title === 'Optics').length).toBe(2);

  await openSidebar(page);
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  const row = page.locator('.book-list li', { hasText: 'Physics' });
  const file = await downloaded(page, () => row.getByRole('button', { name: 'Export notebook' }).click());
  expect(file.name).toBe('Physics.lbd');
  if (!(await page.locator('.book-panel').isVisible())) await page.locator('.book-button').click();
  await page.locator('.book-list li', { hasText: 'Physics' }).getByRole('button', { name: 'Delete notebook' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Delete notebook' }).click();
  await expect.poll(async () => (await localState(page)).books.map((b) => b.name)).toEqual(['My Notebook']);

  await importBytes(page, file.name, file.bytes);
  await expect(page.locator('#toast')).toContainText('Imported 2 notes into a new notebook');
  const st = await localState(page);
  const physics = st.books.find((b) => b.name === 'Physics')!;
  expect(st.notes.filter((n) => n.notebook_id === physics.id).map((n) => n.title).sort()).toEqual(['Optics', 'Waves']);
  expect(st.notes.find((n) => n.title === 'Waves')!.strokes).toHaveLength(1);
});

test('a zip of several .lbd files imports them all; dropping a file on the board imports it too', async ({ page }) => {
  await setup(page);
  const a = lbd([{ title: 'First', strokes: [{ tool: 'pen', color: '#111827', width: 3, points: [10, 10, 0.5, 50, 10, 0.5] }] }]);
  const b = lbd([{ title: 'Second', strokes: [{ tool: 'text', color: '#dc2626', width: 28, points: [20, 20, 0], text: 'Hi', font: { family: 'mono' } }] }], {}, []);
  await importBytes(page, 'bundle.zip', makeZip([['first.lbd', a], ['folder/second.lbd', b], ['notes.txt', Buffer.from('ignore me')]]));
  await expect(page.locator('#toast')).toContainText('Imported 2 notes');
  let st = await localState(page);
  expect(st.notes.find((n) => n.title === 'Second')!.strokes[0]).toMatchObject({ tool: 'text', text: 'Hi', font: { family: 'mono' } });

  // Drag and drop.
  const dropped = lbd([{ title: 'Dropped', strokes: [{ tool: 'pen', color: '#111827', width: 3, points: [10, 10, 0.5, 60, 20, 0.5] }] }]);
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Dropped.lbd'));
    document.querySelector('.board-host')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [...dropped]);
  await expect(page.locator('.title-input')).toHaveValue('Dropped');
  st = await localState(page);
  expect(st.notes.some((n) => n.title === 'Dropped')).toBe(true);
});

test('bad files are refused with a reason, and damaged strokes are left out', async ({ page }) => {
  await setup(page);
  const before = (await localState(page)).notes.length;
  await importBytes(page, 'notes.lbd', Buffer.from('this is not a zip'));
  await expect(page.locator('#toast')).toContainText('not a Lineboard file');
  await importBytes(page, 'other.zip', makeZip([['hello.txt', Buffer.from('hi')]]));
  await expect(page.locator('#toast')).toContainText('no Lineboard files');
  await importBytes(page, 'future.lbd', lbd([{ title: 'X', strokes: [] }], { version: 99 }));
  await expect(page.locator('#toast')).toContainText('newer version of Lineboard');
  await importBytes(page, 'damaged.lbd', makeZip([['lineboard.json', Buffer.from('{not json')]]));
  await expect(page.locator('#toast')).toContainText('damaged');
  expect((await localState(page)).notes.length).toBe(before);

  // One good stroke, four bad ones (unknown tool, a script for a colour, endless points, a missing picture).
  await importBytes(
    page,
    'mixed.lbd',
    lbd([
      {
        title: 'Mixed',
        strokes: [
          { tool: 'pen', color: '#111827', width: 3, points: [10, 10, 0.5, 50, 10, 0.5] },
          { tool: 'laser', color: '#111827', width: 3, points: [1, 1, 1] },
          { tool: 'pen', color: '<img src=x onerror=alert(1)>', width: 3, points: [1, 1, 1] },
          { tool: 'pen', color: '#111827', width: 3, points: Array(90_000).fill(1) },
          { tool: 'image', width: 1, points: [0, 0, 0, 10, 10, 0], picture: 'pictures/missing.png' },
        ],
      },
    ]),
  );
  await expect(page.locator('#toast')).toContainText('4 damaged items were left out');
  const mixed = (await localState(page)).notes.find((n) => n.title === 'Mixed')!;
  expect(mixed.strokes).toHaveLength(1);
});

test('with an account: import uploads the pictures, and "Export all notes" asks who you are', async ({ page }) => {
  const db = await mockSupabase(page);
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('friend@example.com');
  await page.getByLabel('Password', { exact: true }).fill('secret123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await attachBoard(page);
  const file = lbd(
    [{ title: 'With picture', strokes: [{ tool: 'image', width: 1, points: [100, 100, 0, 300, 250, 0], picture: 'pictures/a.png' }] }],
    {},
    [['pictures/a.png', PNG]],
  );
  await importBytes(page, 'pic.lbd', file);
  await expect(page.locator('#toast')).toContainText('Imported “With picture”');
  await expect.poll(() => db.images?.size ?? 0).toBe(1);
  await expect.poll(() => db.strokes.filter((s) => s.tool === 'image').length).toBe(1);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'Account' }).click();
  await page.getByRole('button', { name: 'Export all notes (.lbd)' }).click();
  const ask = page.locator('dialog.confirm-dialog');
  await expect(ask).toContainText('Exporting all your notes');
  const wait = page.waitForEvent('download');
  await ask.locator('input[type=password]').fill('secret123');
  await ask.getByRole('button', { name: 'Confirm' }).click();
  const d = await wait;
  expect(d.suggestedFilename()).toMatch(/^Lineboard notes \d{4}-\d{2}-\d{2}\.lbd$/);
  const parts = unzip(readFileSync((await d.path())!));
  expect([...parts.keys()].some((k) => k.startsWith('pictures/'))).toBe(true);
});
