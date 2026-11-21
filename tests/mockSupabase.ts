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
  /** note_versions (version history). */
  versions?: Row[];
  /** Set to make the database look as if schema.sql predates version history. */
  noHistory?: boolean;
  /** Auth emails sent (sign-up confirmation, links, resets): address and time, like Supabase's 60 s wait. */
  emails?: { to: string; at: number; kind: string }[];
  /** The auth user's user_metadata (display name, picture version). */
  meta?: Record<string, unknown>;
  /** Set to make the database look as if schema.sql predates stars and the archive. */
  noFlags?: boolean;
  /** Set to make the database look as if schema.sql predates the trash. */
  noTrash?: boolean;
  settings: Row | null;
  keys: Row | null;
  /** Auth server state: signed-in sessions, MFA factors, passkeys, password changes. */
  sessions: Session[];
  factors: Row[];
  passkeys: Row[];
  passwordChanges: number;
  /** The account password (tests sign in with it). */
  password: string;
  /** Supabase Storage: path within the bucket -> bytes and content type. */
  images?: Map<string, { body: Buffer; type: string }>;
  /** Set once delete_my_account ran: the user no longer exists. */
  deleted?: boolean;
  /** Bot check on (Supabase "CAPTCHA protection"): auth requests need a token; the ones received. */
  captcha?: boolean;
  captchaTokens?: string[];
}

export interface Session {
  id: string;
  aal: 'aal1' | 'aal2';
  user_agent: string;
  ip: string;
  created_at: string;
}

/** The TOTP code the mock accepts. */
export const MOCK_TOTP = '123456';

const b64url = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');

/** An unsigned JWT in the shape Supabase issues; the client only decodes it. */
function jwt(session: Session) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: USER_ID, role: 'authenticated', aud: 'authenticated', aal: session.aal, session_id: session.id, amr: [{ method: 'password', timestamp: now }], iat: now, exp: now + 3600 };
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`;
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
    else if (raw.startsWith('lt.')) tests.push((r) => r[col] != null && String(r[col]) < raw.slice(3));
  }
  return (r: Row) => tests.every((t) => t(r));
}

function paginate(url: URL, rows: Row[]) {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  // Like a Supabase project's API: at most 1000 rows per response (max rows), whatever was asked.
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), 1000);
  return rows.slice(offset, offset + limit);
}

/** Pass `shared` to give a second browser context (another device) the same database. */
export async function mockSupabase(page: Page, shared?: MockDb, opts: { captcha?: boolean } = {}): Promise<MockDb> {
  const db: MockDb = shared ?? { notebooks: [], notes: [], strokes: [], settings: null, keys: null, sessions: [], factors: [], passkeys: [], passwordChanges: 0, password: 'secret123' };
  if (opts.captcha) db.captcha = true;

  await page.route('**/config.js', (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `window.__LINEBOARD_CONFIG__ = { supabaseUrl: "${MOCK_URL}", supabaseAnonKey: "test-anon-key"${db.captcha ? ', turnstileSiteKey: "test-site-key"' : ''} };`,
    }),
  );
  // A stand-in for Cloudflare Turnstile: passes at once, and gives a fresh token after each reset.
  await page.route('https://challenges.cloudflare.com/**', (r) =>
    r.fulfill({
      contentType: 'application/javascript',
      body: `window.turnstile = { n: 0, w: {},
        render(el, o) { const id = 'w' + (++this.n); this.w[id] = o; setTimeout(() => o.callback('tok-' + id + '-1'), 20); return id; },
        reset(id) { const o = this.w[id]; o.k = (o.k || 1) + 1; setTimeout(() => o.callback('tok-' + id + '-' + o.k), 20); },
        remove(id) { delete this.w[id]; } };`,
    }),
  );

  const json = (route: Route, status: number, body: unknown, extra: Record<string, string> = {}) =>
    route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const denied = (route: Route) => json(route, 403, { code: '42501', message: 'new row violates row-level security policy' });

  const user = () => ({
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'friend@example.com',
    app_metadata: {},
    user_metadata: db.meta ?? {},
    created_at: '2026-01-01T00:00:00Z',
    factors: db.factors,
  });

  const tokenResponse = (session: Session) => {
    const now = Math.floor(Date.now() / 1000);
    return { access_token: jwt(session), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'refresh-' + session.id, user: user() };
  };
  const newSession = (ua: string): Session => {
    const session: Session = { id: crypto.randomUUID(), aal: 'aal1', user_agent: ua, ip: '203.0.113.' + (db.sessions.length + 7), created_at: new Date().toISOString() };
    db.sessions.push(session);
    return session;
  };
  const authError = (route: Route, status: number, code: string, msg: string) => json(route, status, { code, error_code: code, msg, message: msg });

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
    const body = () => {
      const d = req.postData();
      return d ? JSON.parse(d) : null;
    };
    const ua = req.headers()['user-agent'] ?? '';

    // The session the request's access token belongs to (null: none, or signed out elsewhere).
    const bearer = (req.headers()['authorization'] ?? '').replace(/^Bearer /, '');
    let claims: { session_id?: string; aal?: string } = {};
    try {
      claims = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString() || '{}');
    } catch {
      /* the anon key */
    }
    const session = db.sessions.find((x) => x.id === claims.session_id) ?? null;
    /** The schema's access_ok(): a live session, at aal2 if two-step verification is on. */
    const accessOk = () => !!session && (claims.aal === 'aal2' || !db.factors.some((f) => f.status === 'verified'));

    // ---- auth ----
    // Bot check: sign-in, sign-up, email links and resets need a token (refreshes do not).
    const needsCaptcha = (path === '/auth/v1/token' && url.searchParams.get('grant_type') !== 'refresh_token') || ['/auth/v1/signup', '/auth/v1/otp', '/auth/v1/recover'].includes(path);
    if (db.captcha && needsCaptcha && method === 'POST') {
      const tok = (body() as { gotrue_meta_security?: { captcha_token?: string } } | null)?.gotrue_meta_security?.captcha_token;
      if (!tok) return authError(route, 400, 'captcha_failed', 'captcha protection: request disallowed (no captcha token)');
      if ((db.captchaTokens ??= []).includes(tok)) return authError(route, 400, 'captcha_failed', 'captcha protection: token already used');
      db.captchaTokens.push(tok);
    }
    if (path === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') {
        const id = String(body()?.refresh_token ?? '').replace(/^refresh-/, '');
        const existing = db.sessions.find((x) => x.id === id);
        if (!existing) return authError(route, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        return json(route, 200, tokenResponse(existing));
      }
      if (grant === 'password' && (db.deleted || body()?.password !== db.password)) return authError(route, 400, 'invalid_credentials', 'Invalid login credentials');
      return json(route, 200, tokenResponse(newSession(ua)));
    }
    if (path === '/auth/v1/user') {
      if (!session) return authError(route, 403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
      if (method === 'PUT') {
        const b = body() ?? {};
        if (b.current_password !== undefined && b.current_password !== db.password) return authError(route, 400, 'invalid_credentials', 'Current password is incorrect');
        if (b.password) {
          db.password = b.password;
          db.passwordChanges++;
        }
        if (b.data) db.meta = { ...(db.meta ?? {}), ...b.data };
        return json(route, 200, user());
      }
      return json(route, 200, user());
    }
    if (path === '/auth/v1/logout') {
      const scope = url.searchParams.get('scope') ?? 'global';
      if (session) db.sessions = db.sessions.filter((x) => (scope === 'others' ? x.id === session.id : scope === 'local' ? x.id !== session.id : false));
      return route.fulfill({ status: 204, headers: cors });
    }

    // two-step verification
    if (path === '/auth/v1/factors' && method === 'POST') {
      const b = body();
      const f = { id: crypto.randomUUID(), factor_type: b.factor_type, friendly_name: b.friendly_name, status: 'unverified', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      db.factors.push(f);
      const secret = 'JBSWY3DPEHPK3PXP';
      return json(route, 200, {
        id: f.id,
        type: 'totp',
        friendly_name: f.friendly_name,
        totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', secret, uri: `otpauth://totp/Lineboard:friend?secret=${secret}` },
      });
    }
    let m = /^\/auth\/v1\/factors\/([^/]+)(\/challenge|\/verify)?$/.exec(path);
    if (m) {
      const f = db.factors.find((x) => x.id === m![1]);
      if (!f) return authError(route, 404, 'mfa_factor_not_found', 'Factor not found');
      if (method === 'DELETE') {
        if (f.status === 'verified' && claims.aal !== 'aal2') return authError(route, 403, 'insufficient_aal', 'AAL2 required');
        db.factors = db.factors.filter((x) => x !== f);
        return json(route, 200, { id: f.id });
      }
      if (m[2] === '/challenge') return json(route, 200, { id: crypto.randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
      if (m[2] === '/verify') {
        if (body()?.code !== MOCK_TOTP) return authError(route, 422, 'mfa_verification_failed', 'Invalid TOTP code entered');
        const wasNew = f.status !== 'verified';
        f.status = 'verified';
        session!.aal = 'aal2';
        // Turning on a new factor signs out every other session.
        if (wasNew) db.sessions = db.sessions.filter((x) => x.id === session!.id);
        return json(route, 200, tokenResponse(session!));
      }
    }

    // passkeys (WebAuthn ceremony against a Chromium virtual authenticator)
    if (path === '/auth/v1/passkeys/registration/options') {
      return json(route, 200, {
        challenge_id: crypto.randomUUID(),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        options: {
          challenge: b64url(crypto.getRandomValues(new Uint8Array(32))),
          rp: { id: 'localhost', name: 'Lineboard' },
          user: { id: b64url(USER_ID), name: 'friend@example.com', displayName: 'friend@example.com' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          timeout: 60000,
          attestation: 'none',
        },
      });
    }
    if (path === '/auth/v1/passkeys/registration/verify') {
      const p = { id: crypto.randomUUID(), credential_id: body().credential.id, friendly_name: 'Passkey', created_at: new Date().toISOString() };
      db.passkeys.push(p);
      return json(route, 200, p);
    }
    if (path === '/auth/v1/passkeys/authentication/options') {
      return json(route, 200, {
        challenge_id: crypto.randomUUID(),
        expires_at: Math.floor(Date.now() / 1000) + 300,
        options: { challenge: b64url(crypto.getRandomValues(new Uint8Array(32))), rpId: 'localhost', allowCredentials: [], userVerification: 'preferred', timeout: 60000 },
      });
    }
    if (path === '/auth/v1/passkeys/authentication/verify') {
      const p = db.passkeys.find((x) => x.credential_id === body().credential.id);
      if (!p) return authError(route, 400, 'invalid_credentials', 'Unknown passkey');
      p.last_used_at = new Date().toISOString();
      return json(route, 200, tokenResponse(newSession(ua)));
    }
    if (path === '/auth/v1/passkeys' || path === '/auth/v1/passkeys/') return json(route, 200, db.passkeys);
    m = /^\/auth\/v1\/passkeys\/([^/]+)$/.exec(path);
    if (m) {
      const p = db.passkeys.find((x) => x.id === m![1]);
      if (method === 'DELETE') db.passkeys = db.passkeys.filter((x) => x !== p);
      if (method === 'PATCH' && p) p.friendly_name = body().friendly_name;
      return json(route, 200, p ?? null);
    }
    // Emails (sign-up confirmation, sign-in link, password reset, resend): one per address per 60 s,
    // refused with Supabase's own message and the seconds left.
    if (['/auth/v1/signup', '/auth/v1/otp', '/auth/v1/recover', '/auth/v1/resend'].includes(path) && method === 'POST') {
      const to = String(body()?.email ?? '').toLowerCase();
      db.emails ??= [];
      const last = db.emails.filter((x) => x.to === to).pop();
      const left = last ? Math.ceil(60 - (Date.now() - last.at) / 1000) : 0;
      if (left > 0) return authError(route, 429, 'over_email_send_rate_limit', `For security purposes, you can only request this after ${left} seconds.`);
      db.emails.push({ to, at: Date.now(), kind: path.split('/').pop()! });
      if (path === '/auth/v1/signup') return json(route, 200, { ...user(), email: to, confirmation_sent_at: new Date().toISOString() });
      return json(route, 200, {});
    }
    if (path.startsWith('/auth/v1/')) return route.fulfill({ status: 204, headers: cors });

    // ---- storage (pictures): list a folder, remove files ----
    if (path === '/storage/v1/object/list/images' && method === 'POST') {
      db.images ??= new Map();
      const prefix = String(body()?.prefix ?? '').replace(/\/$/, '');
      if (!accessOk() || prefix !== USER_ID) return json(route, 200, []);
      const limit = Number(body()?.limit ?? 100);
      const names = [...db.images.keys()].filter((k) => k.startsWith(prefix + '/')).map((k) => k.slice(prefix.length + 1));
      return json(route, 200, names.slice(0, limit).map((name) => ({ name, id: crypto.randomUUID(), metadata: { size: db.images!.get(`${prefix}/${name}`)!.body.length } })));
    }
    if (path === '/storage/v1/object/images' && method === 'DELETE') {
      db.images ??= new Map();
      if (!accessOk()) return json(route, 403, { statusCode: '403', error: 'Unauthorized', message: 'Not allowed' });
      const prefixes = (body()?.prefixes ?? []) as string[];
      const removed = prefixes.filter((k) => k.startsWith(USER_ID + '/') && db.images!.delete(k));
      return json(route, 200, removed.map((name) => ({ name })));
    }

    // ---- deleting the account ----
    if (path === '/rest/v1/rpc/delete_my_account') {
      if (!accessOk()) return json(route, 403, { code: '42501', message: 'Not allowed' });
      Object.assign(db, { notebooks: [], notes: [], strokes: [], versions: [], settings: null, keys: null, sessions: [], factors: [], passkeys: [], deleted: true });
      return route.fulfill({ status: 204, headers: cors, body: '' });
    }

    // ---- storage (pictures) ----
    const so = /^\/storage\/v1\/object\/images\/(.+)$/.exec(path);
    if (so) {
      db.images ??= new Map();
      const key = decodeURIComponent(so[1]);
      if (!accessOk() || !key.startsWith(USER_ID + '/')) return json(route, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (method === 'POST' || method === 'PUT') {
        db.images.set(key, { body: req.postDataBuffer() ?? Buffer.alloc(0), type: req.headers()['content-type'] ?? 'application/octet-stream' });
        return json(route, 200, { Key: 'images/' + key, Id: crypto.randomUUID() });
      }
      if (method === 'GET') {
        const f = db.images.get(key);
        if (!f) return json(route, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': f.type }, body: f.body });
      }
    }

    // ---- signed-in devices (rpc) ----
    if (path === '/rest/v1/rpc/list_my_sessions' || path === '/rest/v1/rpc/revoke_my_session') {
      if (!accessOk()) return json(route, 403, { code: '42501', message: 'Not allowed' });
      if (path.endsWith('revoke_my_session')) {
        const target = body()?.target;
        const before = db.sessions.length;
        db.sessions = db.sessions.filter((x) => x.id !== target);
        return json(route, 200, db.sessions.length < before);
      }
      return json(
        route,
        200,
        [...db.sessions].reverse().map((x) => ({ id: x.id, created_at: x.created_at, last_active: x.created_at, user_agent: x.user_agent, ip: x.ip, aal: x.aal, is_current: x.id === session?.id })),
      );
    }

    // Restrictive policy: no live session (or missing second step) means no rows and no writes.
    if (path.startsWith('/rest/v1/') && !accessOk()) {
      if (method === 'GET') return json(route, 200, []);
      return json(route, 403, { code: '42501', message: 'new row violates row-level security policy' });
    }

    const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    const prefer = req.headers()['prefer'] ?? '';
    const match = matches(url);
    const now = () => new Date().toISOString();

    const cascadeNotes = (ids: unknown[]) => {
      db.notes = db.notes.filter((n) => !ids.includes(n.id));
      db.strokes = db.strokes.filter((s) => !ids.includes(s.note_id));
      db.versions = (db.versions ?? []).filter((v) => !ids.includes(v.note_id));
    };

    // ---- notebooks / notes ----
    if (db.noFlags && (path === '/rest/v1/notebooks' || path === '/rest/v1/notes') && /starred|archived_at/.test((url.searchParams.get('select') ?? '') + (req.postData() ?? '')))
      return json(route, 400, { code: '42703', message: `column ${path.slice(9)}.starred does not exist` });
    if (db.noTrash && (path === '/rest/v1/notebooks' || path === '/rest/v1/notes') && /deleted_at/.test((url.searchParams.get('select') ?? '') + (req.postData() ?? '')))
      return json(route, 400, { code: '42703', message: `column ${path.slice(9)}.deleted_at does not exist` });
    if (path === '/rest/v1/notebooks' || path === '/rest/v1/notes') {
      const table = path.endsWith('notebooks') ? 'notebooks' : 'notes';
      const rows = () => db[table];
      const set = (v: Row[]) => (db[table] = v);
      // Like the foreign key and the notes_notebook_live trigger (supabase/schema.sql): a note's
      // notebook must exist and not be in the trash.
      const badNotebook = (row: Row, before?: Row) => {
        if (table !== 'notes' || row.notebook_id == null || (before && before.notebook_id === row.notebook_id)) return null;
        const b = db.notebooks.find((x) => x.id === row.notebook_id);
        if (!b) return 'insert or update on table "notes" violates foreign key constraint "notes_notebook_id_fkey"';
        if (b.deleted_at) return 'Lineboard: that notebook is in the trash';
        return null;
      };
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
          const fk = badNotebook(row, existing);
          if (fk) return json(route, 409, { code: '23503', message: fk });
          set(rows().filter((b) => b.id !== row.id).concat(row));
          saved.push(row);
        }
        return wantsObject ? json(route, 201, saved[0]) : route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'PATCH') {
        const patch = body();
        const next = rows().map((b) => (match(b) ? { ...b, ...patch } : b));
        if (next.some((b, i) => b !== rows()[i] && !allowed(table, b))) return denied(route);
        for (const [i, b] of next.entries()) {
          const fk = b !== rows()[i] ? badNotebook(b, rows()[i]) : null;
          if (fk) return json(route, 409, { code: '23503', message: fk });
        }
        const changed = next.filter((b, i) => b !== rows()[i]);
        set(next);
        // With .select(): the rows it changed (none when the row is gone).
        if (prefer.includes('return=representation')) return json(route, 200, wantsObject ? (changed[0] ?? null) : changed);
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        const removed = rows().filter(match);
        const gone = removed.map((r) => r.id);
        set(rows().filter((r) => !match(r)));
        if (table === 'notebooks') cascadeNotes(db.notes.filter((n) => gone.includes(n.notebook_id)).map((n) => n.id));
        else cascadeNotes(gone);
        if (prefer.includes('return=representation')) return json(route, 200, removed);
        return route.fulfill({ status: 204, headers: cors });
      }
    }

    // ---- strokes ----
    if (path === '/rest/v1/strokes') {
      if (method === 'GET') return json(route, 200, paginate(url, db.strokes.filter(match)));
      if (method === 'POST') {
        const incoming = [body()].flat() as Row[];
        if (incoming.some((r) => !allowed('strokes', r))) return denied(route);
        if (incoming.some((r) => !db.notes.some((n) => n.id === r.note_id)))
          return json(route, 409, { code: '23503', message: 'insert or update on table "strokes" violates foreign key constraint "strokes_note_id_fkey"' });
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

    // ---- note_versions ----
    if (path === '/rest/v1/note_versions') {
      if (db.noHistory) return json(route, 404, { code: 'PGRST205', message: "Could not find the table 'public.note_versions' in the schema cache" });
      db.versions ??= [];
      // The schema's policy: with encryption on, the snapshot must be encrypted and the name too.
      const ok = (r: Row) => (!encryptionRequired() || (!!r.data_enc && r.name == null)) && db.notes.some((n) => n.id === r.note_id);
      if (method === 'GET') {
        const byId = (url.searchParams.get('order') ?? '').startsWith('id');
        const rows = db.versions.filter(match).sort((a, b) => (byId ? String(a.id).localeCompare(String(b.id)) : String(b.created_at).localeCompare(String(a.created_at))));
        if (wantsObject) return rows[0] ? json(route, 200, rows[0]) : json(route, 406, { code: 'PGRST116', message: 'no rows' });
        return json(route, 200, paginate(url, rows));
      }
      if (method === 'POST') {
        const incoming = [body()].flat() as Row[];
        if (incoming.some((r) => !ok(r))) return denied(route);
        for (const r of incoming) db.versions = db.versions.filter((v) => v.id !== r.id).concat({ created_at: now(), ...r });
        return route.fulfill({ status: 201, headers: cors });
      }
      if (method === 'PATCH') {
        const patch = body();
        const next = db.versions.map((v) => (match(v) ? { ...v, ...patch } : v));
        if (next.some((v, i) => v !== db.versions![i] && !ok(v))) return denied(route);
        db.versions = next;
        return route.fulfill({ status: 204, headers: cors });
      }
      if (method === 'DELETE') {
        db.versions = db.versions.filter((v) => !match(v));
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

/** The URL fragment a password-reset email link lands with (signs in a new recovery session). */
export function recoveryHash(db: MockDb, ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36') {
  const session: Session = { id: crypto.randomUUID(), aal: 'aal1', user_agent: ua, ip: '198.51.100.4', created_at: new Date().toISOString() };
  db.sessions.push(session);
  return `#access_token=${jwt(session)}&expires_in=3600&expires_at=${Math.floor(Date.now() / 1000) + 3600}&refresh_token=refresh-${session.id}&token_type=bearer&type=recovery`;
}
