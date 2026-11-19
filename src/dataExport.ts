import { buildLbd } from './lbd';
import type { Store } from './store/store';
import type { AppUser, Settings, Stroke } from './types';
import { zip } from './zip';

/**
 * "Download my data": everything the account (or this device, in guest mode) holds, in open,
 * machine-readable form (data portability, GDPR art. 20). A zip with:
 *   README.txt         what is in it
 *   account.json       the account and its settings
 *   notes.lbd          every notebook, note and picture, as a Lineboard file (see lbd.ts and
 *                      docs/file-format.md); it can be imported back into Lineboard
 */
export async function buildExport(
  store: Store,
  user: AppUser,
  settings: Settings,
  pending: (noteId: string, saved: Stroke[]) => Stroke[] = (_, saved) => saved,
): Promise<Blob> {
  const enc = new TextEncoder();
  const [books, notes] = await Promise.all([store.listNotebooks(), store.listNotes()]);
  const groups = books.map((notebook) => ({ notebook, notes: notes.filter((n) => n.notebook_id === notebook.id) }));
  // Notes not in any notebook (older data, from before notebooks existed).
  const unfiled = notes.filter((n) => !books.some((b) => b.id === n.notebook_id));
  if (unfiled.length) groups.push({ notebook: { id: '', name: 'Unfiled notes', created_at: '', updated_at: '' }, notes: unfiled });
  const lbd = await buildLbd(store, groups, pending);

  const account = {
    format: 'lineboard-account',
    version: 1,
    exported_at: new Date().toISOString(),
    account: store.mode === 'cloud' ? { id: user.id, email: user.email } : { local: true, note: 'Notes kept in this browser without an account.' },
    settings,
  };
  const readme = [
    'Lineboard data export',
    '',
    'account.json   Your account details and settings.',
    'notes.lbd      All your notebooks and notes, with their pictures, as a Lineboard file.',
    '               Import it in Lineboard (Notes > Import) to get them back, in this or another account.',
    '               An .lbd file is a zip archive: lineboard.json lists the notebooks, notes/*.json hold',
    '               each note (strokes as x, y, pressure points; text; shapes) and pictures/ the pictures.',
    '               The format is described at https://github.com/lnandanapalli/lineboard/blob/main/docs/file-format.md',
    '',
    `Exported ${new Date().toUTCString()}.`,
  ].join('\n');
  return zip([
    { name: 'README.txt', data: enc.encode(readme), compress: true },
    { name: 'account.json', data: enc.encode(JSON.stringify(account, null, 2)), compress: true },
    { name: 'notes.lbd', data: new Uint8Array(await lbd.arrayBuffer()) },
  ]);
}
