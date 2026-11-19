import { icons } from './icons';
import { MAX_QUERY, parseQuery, score } from './search';
import type { Notebook, NoteMeta } from './types';
import { h } from './util';

export interface SearchHost {
  notes: () => NoteMeta[];
  notebooks: () => Notebook[];
  openNote: (n: NoteMeta) => Promise<void>;
  openNotebook: (b: Notebook) => Promise<void>;
  /** An archived result was picked: ask, and restore it if wanted (true: restored). */
  restore: (kind: 'note' | 'notebook', item: NoteMeta | Notebook) => Promise<boolean>;
}

type Result = { kind: 'note'; item: NoteMeta; score: number } | { kind: 'notebook'; item: Notebook; score: number };

const MAX_RESULTS = 50;
const RECENT = 8;
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * Search notes and notebooks in a window of its own (Ctrl/⌘ K). Each result says whether it is a
 * note or a notebook; with no query, the most recent notes are listed. Arrow keys move, Enter
 * opens, Escape closes. Archived ones are left out unless asked for.
 */
export function openSearch(host: SearchHost) {
  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search notes and notebooks', 'aria-label': 'Search notes and notebooks', maxlength: String(MAX_QUERY), autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'search-results', 'aria-autocomplete': 'list' }) as HTMLInputElement;
  const archived = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const list = h('ul', { class: 'search-results', id: 'search-results', role: 'listbox', 'aria-label': 'Results' });
  const status = h('p', { class: 'search-status', role: 'status' });
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close search', title: 'Close' });
  close.innerHTML = icons.close;
  const icon = h('span', { class: 'search-icon', 'aria-hidden': 'true' });
  icon.innerHTML = icons.search;
  const dlg = h(
    'dialog',
    { class: 'modal search-modal', 'aria-label': 'Search' },
    h('div', { class: 'search-bar' }, icon, input, close),
    h('label', { class: 'search-option' }, archived, h('span', {}, 'Include archived')),
    status,
    list,
    h('p', { class: 'search-keys', 'aria-hidden': 'true' }, '↑ ↓ to move · Enter to open · Esc to close · "quotes" for an exact phrase'),
  );
  document.body.append(dlg);

  let results: Result[] = [];
  let active = 0;
  const books = () => new Map(host.notebooks().map((b) => [b.id, b]));

  const run = () => {
    const q = parseQuery(input.value);
    const byId = books();
    const archivedBook = (id: string | null) => !!(id && byId.get(id)?.archived_at);
    const include = archived.checked;
    const notes = host.notes().filter((n) => include || (!n.archived_at && !archivedBook(n.notebook_id)));
    const notebooks = host.notebooks().filter((b) => include || !b.archived_at);
    if (!q.words.length && !q.phrases.length) {
      results = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, RECENT).map((item) => ({ kind: 'note' as const, item, score: 0 }));
      status.textContent = results.length ? 'Recent notes' : 'No notes yet.';
    } else {
      const found: Result[] = [];
      for (const item of notes) {
        const s = score(item.title || 'Untitled', q);
        if (s) found.push({ kind: 'note', item, score: s + (item.starred ? 10 : 0) });
      }
      for (const item of notebooks) {
        const s = score(item.name, q);
        if (s) found.push({ kind: 'notebook', item, score: s + (item.starred ? 10 : 0) });
      }
      found.sort((a, b) => b.score - a.score || b.item.updated_at.localeCompare(a.item.updated_at));
      results = found.slice(0, MAX_RESULTS);
      status.textContent = found.length ? `${found.length} result${found.length === 1 ? '' : 's'}${found.length > MAX_RESULTS ? ` (showing the best ${MAX_RESULTS})` : ''}` : 'Nothing found. Try fewer or shorter words.';
    }
    active = 0;
    render(byId);
  };

  const render = (byId = books()) => {
    list.replaceChildren(
      ...results.map((r, i) => {
        const name = r.kind === 'note' ? r.item.title || 'Untitled' : r.item.name;
        const where =
          r.kind === 'note'
            ? `${byId.get(r.item.notebook_id ?? '')?.name ?? ''} · ${fmt.format(new Date(r.item.updated_at))}`
            : (() => {
                const n = host.notes().filter((x) => x.notebook_id === r.item.id && !x.archived_at).length;
                return n === 1 ? '1 note' : `${n} notes`;
              })();
        const li = h(
          'li',
          { class: 'search-result' + (i === active ? ' active' : ''), role: 'option', id: `search-r${i}`, 'aria-selected': String(i === active) },
          h('span', { class: 'search-kind ' + r.kind }, r.kind === 'note' ? 'Note' : 'Notebook'),
          h('span', { class: 'search-text' }, h('b', {}, name), h('small', {}, where + (r.item.archived_at ? ' · Archived' : ''))),
          r.item.starred ? h('span', { class: 'search-star', 'aria-label': 'Starred' }, '★') : null,
        );
        li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the field
        li.addEventListener('click', () => void pick(i));
        return li;
      }),
    );
    if (results.length) input.setAttribute('aria-activedescendant', `search-r${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const move = (d: number) => {
    if (!results.length) return;
    active = (active + d + results.length) % results.length;
    render();
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const pick = async (i: number) => {
    const r = results[i];
    if (!r) return;
    // An archived result (or a note in an archived notebook) is restored first, if wanted.
    const book = r.kind === 'note' ? books().get(r.item.notebook_id ?? '') : undefined;
    const target = r.item.archived_at ? r : book?.archived_at ? { kind: 'notebook' as const, item: book } : null;
    if (target && !(await host.restore(target.kind, target.item))) return;
    done();
    if (r.kind === 'note') await host.openNote(r.item);
    else await host.openNotebook(r.item);
  };

  const done = () => {
    dlg.close();
    dlg.remove();
  };

  input.addEventListener('input', run);
  archived.addEventListener('change', () => {
    run();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void pick(active);
    } else if (e.key === 'Escape') {
      // A search field's own Escape only clears it; here Escape closes, as in other apps' search.
      e.preventDefault();
      done();
    }
  });
  close.addEventListener('click', done);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    done();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) done();
  });
  dlg.showModal();
  input.focus();
  run();
  return { close: done };
}
