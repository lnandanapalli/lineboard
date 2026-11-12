import type { Page, Route } from '@playwright/test';

/**
 * A tiny in-memory stand-in for the Supabase endpoints Lineboard uses (auth + three tables),
 * served through Playwright request interception. Lets tests cover signed-in flows with no real backend.
 */

export const MOCK_URL = 'https://mock-project.supabase.co';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;
export interface MockDb {
  notes: Row[];
  strokes: Row[];
  settings: Row | null;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range',
};

export async function mockSupabase(page: Page): Promise<MockDb> {
  const db: MockDb = { notes: [], strokes: [], settings: null };

  await page.route('**/config.js', (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `window.__LINEBOARD_CONFIG__ = { supabaseUrl: "${MOCK_URL}", supabaseAnonKey: "test-anon-key" };`,
    }),
  );

  const json = (route: Route, status: number, body: unknown, extra: Record<string, string> = {}) =>
    route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });

  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'friend@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };

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
    const eqParam = (name: string) => url.searchParams.get(name)?.replace(/^eq\./, '');

    // ---- notes ----
    if (path === '/rest/v1/notes') {
      if (method === 'GET') return json(route, 200, [...db.notes].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
      if (method === 'POST') {
        const rows: Row[] = [body()].flat();
        const saved = rows.map((r) => {
          const now = new Date().toISOString();
          const row = { id: r.id ?? crypto.randomUUID(), created_at: now, updated_at: now, ...r };
          db.notes = db.notes.filter((n) => n.id !== row.id).concat(row);
          return row;
        });
        return wantsObject ? json(route, 201, saved[0]) : route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'PATCH') {
        const id = eqParam('id');
        db.notes = db.notes.map((n) => (n.id === id ? { ...n, ...body() } : n));
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        const id = eqParam('id');
        db.notes = db.notes.filter((n) => n.id !== id);
        db.strokes = db.strokes.filter((s) => s.note_id !== id);
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    // ---- strokes ----
    if (path === '/rest/v1/strokes') {
      if (method === 'GET') {
        const noteId = eqParam('note_id');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const rows = offset ? [] : db.strokes.filter((s) => s.note_id === noteId);
        return json(route, 200, rows);
      }
      if (method === 'POST') {
        for (const r of [body()].flat() as Row[]) db.strokes = db.strokes.filter((s) => s.id !== r.id).concat(r);
        return route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'DELETE') {
        const ids = (url.searchParams.get('id') ?? '').replace(/^in\.\(|\)$/g, '').split(',').map((x) => x.replace(/"/g, ''));
        db.strokes = db.strokes.filter((s) => !ids.includes(String(s.id)));
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    // ---- user_settings ----
    if (path === '/rest/v1/user_settings') {
      if (method === 'GET') {
        if (wantsObject) return db.settings ? json(route, 200, db.settings) : json(route, 406, { code: 'PGRST116', message: 'no rows' });
        return json(route, 200, db.settings ? [db.settings] : []);
      }
      if (method === 'POST') {
        db.settings = [body()].flat()[0] as Row;
        return route.fulfill({ status: 201, headers: cors });
      }
    }

    return json(route, 404, { message: `mock: unhandled ${method} ${path}` });
  });

  return db;
}
