import type { Page, Route } from '@playwright/test';

/**
 * A tiny in-memory stand-in for the Supabase endpoints Lineboard uses (auth + its tables),
 * served through Playwright request interception. Lets tests cover signed-in flows with no real backend.
 * Supports the PostgREST filters the app sends (eq, in, is.null, not.is.null), offset/limit, and the
 * schema's rule that plaintext notes are refused once encryption is on.
 */

export const MOCK_URL = 'https://mock-project.supabase.co';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;
export interface MockDb {
  notebooks: Row[];
  notes: Row[];
  strokes: Row[];
  settings: Row | null;
  keys: Row | null;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range',
};

const NOT_FILTERS = new Set(['select', 'order', 'offset', 'limit', 'on_conflict', 'columns']);

/** Rows matching the request's column filters. */
function matches(url: URL) {
  const tests: ((r: Row) => boolean)[] = [];
  for (const [col, raw] of url.searchParams) {
    if (NOT_FILTERS.has(col)) continue;
    if (raw.startsWith('eq.')) tests.push((r) => String(r[col]) === raw.slice(3));
    else if (raw.startsWith('in.(')) {
      const set = raw.slice(4, -1).split(',').map((x) => x.replace(/"/g, ''));
      tests.push((r) => set.includes(String(r[col])));
    } else if (raw === 'is.null') tests.push((r) => r[col] == null);
    else if (raw === 'not.is.null') tests.push((r) => r[col] != null);
  }
  return (r: Row) => tests.every((t) => t(r));
}

function paginate(url: URL, rows: Row[]) {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = url.searchParams.get('limit');
  return rows.slice(offset, limit ? offset + Number(limit) : undefined);
}

/** Pass `shared` to give a second browser context (another device) the same database. */
export async function mockSupabase(page: Page, shared?: MockDb): Promise<MockDb> {
  const db: MockDb = shared ?? { notebooks: [], notes: [], strokes: [], settings: null, keys: null };

  await page.route('**/config.js', (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `window.__LINEBOARD_CONFIG__ = { supabaseUrl: "${MOCK_URL}", supabaseAnonKey: "test-anon-key" };`,
    }),
  );

  const json = (route: Route, status: number, body: unknown, extra: Record<string, string> = {}) =>
    route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const denied = (route: Route) => json(route, 403, { code: '42501', message: 'new row violates row-level security policy' });

  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'friend@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };

  const encryptionRequired = () => db.keys?.state === 'on';
  /** The schema's row-level security "with check" for encryption. */
  const allowed = (table: 'notebooks' | 'notes' | 'strokes', r: Row) =>
    !encryptionRequired() || !!r[{ notebooks: 'name_enc', notes: 'title_enc', strokes: 'enc' }[table]];

  await page.route(`${MOCK_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    // ---- auth ----
    if (path === '/auth/v1/token') {
      const now = Math.floor(Date.now() / 1000);
      return json(route, 200, { access_token: 'token', token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'refresh', user });
    }
    if (path === '/auth/v1/user') return json(route, 200, user);
    if (path.startsWith('/auth/v1/')) return route.fulfill({ status: 204, headers: cors });

    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    const body = () => {
      const d = req.postData();
      return d ? JSON.parse(d) : null;
    };
    const prefer = req.headers()['prefer'] ?? '';
    const match = matches(url);
    const now = () => new Date().toISOString();

    const cascadeNotes = (ids: unknown[]) => {
      db.notes = db.notes.filter((n) => !ids.includes(n.id));
      db.strokes = db.strokes.filter((s) => !ids.includes(s.note_id));
    };

    // ---- notebooks / notes ----
    if (path === '/rest/v1/notebooks' || path === '/rest/v1/notes') {
      const table = path.endsWith('notebooks') ? 'notebooks' : 'notes';
      const rows = () => db[table];
      const set = (v: Row[]) => (db[table] = v);
      if (method === 'GET') {
        const sorted = [...rows()].sort((a, b) =>
          table === 'notebooks' ? String(a.created_at).localeCompare(String(b.created_at)) : String(b.updated_at).localeCompare(String(a.updated_at)),
        );
        return json(route, 200, paginate(url, sorted.filter(match)));
      }
      if (method === 'POST') {
        const incoming: Row[] = [body()].flat();
        const saved: Row[] = [];
        for (const r of incoming) {
          const existing = rows().find((b) => b.id === r.id);
          if (existing && prefer.includes('ignore-duplicates')) {
            saved.push(existing);
            continue;
          }
          const row = { id: r.id ?? crypto.randomUUID(), created_at: now(), updated_at: now(), ...(table === 'notes' ? { notebook_id: null } : {}), ...existing, ...r };
          if (!allowed(table, row)) return denied(route);
          set(rows().filter((b) => b.id !== row.id).concat(row));
          saved.push(row);
        }
        return wantsObject ? json(route, 201, saved[0]) : route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'PATCH') {
        const patch = body();
        const next = rows().map((b) => (match(b) ? { ...b, ...patch } : b));
        if (next.some((b, i) => b !== rows()[i] && !allowed(table, b))) return denied(route);
        set(next);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        const gone = rows().filter(match).map((r) => r.id);
        set(rows().filter((r) => !match(r)));
        if (table === 'notebooks') cascadeNotes(db.notes.filter((n) => gone.includes(n.notebook_id)).map((n) => n.id));
        else cascadeNotes(gone);
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    // ---- strokes ----
    if (path === '/rest/v1/strokes') {
      if (method === 'GET') return json(route, 200, paginate(url, db.strokes.filter(match)));
      if (method === 'POST') {
        const incoming = [body()].flat() as Row[];
        if (incoming.some((r) => !allowed('strokes', r))) return denied(route);
        for (const r of incoming) db.strokes = db.strokes.filter((s) => s.id !== r.id).concat(r);
        // touch_note trigger
        for (const r of incoming) db.notes = db.notes.map((n) => (n.id === r.note_id ? { ...n, updated_at: now() } : n));
        return route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'DELETE') {
        db.strokes = db.strokes.filter((s) => !match(s));
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    // ---- user_settings / user_keys (one row per user) ----
    if (path === '/rest/v1/user_settings' || path === '/rest/v1/user_keys') {
      const k = path.endsWith('settings') ? 'settings' : 'keys';
      if (method === 'GET') {
        if (wantsObject) return db[k] ? json(route, 200, db[k]) : json(route, 406, { code: 'PGRST116', message: 'no rows' });
        return json(route, 200, db[k] ? [db[k]] : []);
      }
      if (method === 'POST') {
        db[k] = [body()].flat()[0] as Row;
        return route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'PATCH') {
        if (db[k]) db[k] = { ...db[k], ...body() };
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        db[k] = null;
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    return json(route, 404, { message: `mock: unhandled ${method} ${path}` });
  });

  return db;
}
