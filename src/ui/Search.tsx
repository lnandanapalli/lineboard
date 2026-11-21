import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../icons';
import { MAX_QUERY, parseQuery, score } from '../search';
import type { Notebook, NoteMeta } from '../types';
import { Svg } from './Icon';
import { showOverlay } from './overlays';

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
  return showOverlay((close) => <SearchDialog host={host} close={close} />);
}

function SearchDialog({ host, close }: { host: SearchHost; close: () => void }) {
  const d = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    d.current?.showModal();
    input.current?.focus();
  }, []);

  const books = new Map(host.notebooks().map((b) => [b.id, b]));
  const { results, status } = useMemo(() => {
    const q = parseQuery(query);
    const books = new Map(host.notebooks().map((b) => [b.id, b]));
    const archivedBook = (id: string | null) => !!(id && books.get(id)?.archived_at);
    const notes = host.notes().filter((n) => archived || (!n.archived_at && !archivedBook(n.notebook_id)));
    const notebooks = host.notebooks().filter((b) => archived || !b.archived_at);
    if (!q.words.length && !q.phrases.length) {
      const results: Result[] = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, RECENT).map((item) => ({ kind: 'note' as const, item, score: 0 }));
      return { results, status: results.length ? 'Recent notes' : 'No notes yet.' };
    }
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
    return {
      results: found.slice(0, MAX_RESULTS),
      status: found.length ? `${found.length} result${found.length === 1 ? '' : 's'}${found.length > MAX_RESULTS ? ` (showing the best ${MAX_RESULTS})` : ''}` : 'Nothing found. Try fewer or shorter words.',
    };
  }, [host, query, archived]);

  useEffect(() => setActive(0), [query, archived]);
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = async (i: number) => {
    const r = results[i];
    if (!r) return;
    // An archived result, or a note in an archived notebook, is restored first (both, if both are), if wanted.
    const book = r.kind === 'note' ? books.get(r.item.notebook_id ?? '') : undefined;
    if ((r.item.archived_at || book?.archived_at) && !(await host.restore(r.kind, r.item))) return;
    close();
    if (r.kind === 'note') await host.openNote(r.item);
    else await host.openNotebook(r.item);
  };

  const where = (r: Result) => {
    if (r.kind === 'note') return `${books.get(r.item.notebook_id ?? '')?.name ?? ''} · ${fmt.format(new Date(r.item.updated_at))}`;
    const n = host.notes().filter((x) => x.notebook_id === r.item.id && !x.archived_at).length;
    return n === 1 ? '1 note' : `${n} notes`;
  };

  return createPortal(
    <dialog
      className="modal search-modal"
      aria-label="Search"
      ref={d}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === d.current) close();
      }}
    >
      <div className="search-bar">
        <span className="search-icon" aria-hidden="true">
          <Svg icon={icons.search} />
        </span>
        <input
          ref={input}
          type="search"
          className="search-input"
          placeholder="Search notes and notebooks"
          aria-label="Search notes and notebooks"
          maxLength={MAX_QUERY}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-autocomplete="list"
          aria-activedescendant={results.length ? `search-r${active}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (results.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void pick(active);
            } else if (e.key === 'Escape') {
              // A search field's own Escape only clears it; here Escape closes, as in other apps' search.
              e.preventDefault();
              close();
            }
          }}
        />
        <button className="icon-btn" type="button" aria-label="Close search" title="Close" onClick={close}>
          <Svg icon={icons.close} />
        </button>
      </div>
      <label className="search-option">
        <input
          type="checkbox"
          checked={archived}
          onChange={(e) => {
            setArchived(e.target.checked);
            input.current?.focus();
          }}
        />
        <span>Include archived</span>
      </label>
      <p className="search-status" role="status">
        {status}
      </p>
      <ul className="search-results" id="search-results" role="listbox" aria-label="Results" ref={list}>
        {results.map((r, i) => (
          <li
            key={r.kind + r.item.id}
            className={'search-result' + (i === active ? ' active' : '')}
            role="option"
            id={`search-r${i}`}
            aria-selected={i === active}
            onPointerDown={(e) => e.preventDefault()} // keep the caret in the field
            onClick={() => void pick(i)}
          >
            <span className={'search-kind ' + r.kind}>{r.kind === 'note' ? 'Note' : 'Notebook'}</span>
            <span className="search-text">
              <b>{r.kind === 'note' ? r.item.title || 'Untitled' : r.item.name}</b>
              <small>{where(r) + (r.item.archived_at ? ' · Archived' : '')}</small>
            </span>
            {r.item.starred && (
              <span className="search-star" aria-label="Starred">
                ★
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="search-keys" aria-hidden="true">
        ↑ ↓ to move · Enter to open · Esc to close · "quotes" for an exact phrase
      </p>
    </dialog>,
    document.body,
  );
}
