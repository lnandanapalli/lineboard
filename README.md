# Lineboard

**A handwriting whiteboard that ignores your palm, made for tablets without an active pen.**

On tablets without a pen digitizer, a capacitive stylus and a resting palm look the same to the screen.
Lineboard avoids guessing which is which: the page is split into horizontal **strips**, and only the strip
you unlock accepts ink. Your palm can rest anywhere else.

![Lineboard on a tablet in landscape](docs/screenshot.png)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Strip lock.** Tap a lock in the margin to unlock a strip; unlocking one locks the others.
  **Multi-strip** mode unlocks several at once for larger drawings.
- **Palm-safe scrolling.** Drag the margin to scroll, or step line by line with the arrow buttons or keys.
- **Palm filtering inside the unlocked strip:** one stroke at a time, oversized contacts ignored (with a
  calibration pad in Settings), strokes cancelled if a contact grows into a palm, and optional pen-only input
  when an active pen is detected.
- Pen (pressure-aware with active pens), highlighter, stroke eraser, undo / redo, multiple notes, PNG export.
- **Accounts and sync** with Supabase, with background saving that survives reloads and offline periods.
- **Try without an account.** Notes stay in the browser and move into the account on sign-in.
- **Local mode.** With no backend configured, the whole app runs in the browser with no sign-in.
- Installable as a PWA; works in portrait and landscape.

## How it works

Lineboard is a static TypeScript app (Vite, no UI framework, HTML canvas). In production it is served by
nginx in a Docker image.

The browser talks directly to Supabase using the public anon / publishable key. Access control lives in the
database: row-level security in [`supabase/schema.sql`](supabase/schema.sql) limits every user to their own
rows. The container holds no secrets.

Strokes are stored as point lists in page units (the page is 1000 units wide), so notes render the same at
any screen size or orientation.

## Quick start

Requires Node.js 20.19+.

```bash
npm install
npm run dev        # http://localhost:5173, local mode
```

Or run the published image:

```bash
docker run -p 8080:80 ghcr.io/lnandanapalli/lineboard
```

Without configuration, both run in local mode: notes are kept in the browser and there is no sign-in.

## Configuration

To enable accounts and sync, point Lineboard at a Supabase project:

| Docker (read at container start) | Vite dev / build | Value |
| --- | --- | --- |
| `SUPABASE_URL` | `VITE_SUPABASE_URL` | Project URL, e.g. `https://<ref>.supabase.co` (no path) |
| `SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | Anon or publishable key |

For development, copy `.env.example` to `.env.local`. Never use the `service_role` / secret key.

### Database

Run [`supabase/schema.sql`](supabase/schema.sql) once in your project (SQL editor or `psql`). It creates the
`notes`, `strokes` and `user_settings` tables with row-level security, and is safe to re-run.

In Supabase Auth, add your site's URL to the allowed redirect URLs so that confirmation, sign-in-link and
password-reset emails work.

### Deployment

The image is a plain static site on port 80 with a health check at `/healthz`, so it runs on any container
host. The included GitHub Actions publish it to GitHub Container Registry and can optionally deploy to
Azure App Service; see [docs/deployment.md](docs/deployment.md).

## Development

```bash
npm run dev         # dev server
npm run typecheck
npm test            # Playwright end-to-end tests (run `npx playwright install chromium` once)
npm run build       # production build in dist/
```

The tests simulate stylus and palm contacts of different sizes, and cover the signed-in flows against an
in-memory Supabase stand-in, so they need no backend or keys.

```
src/board.ts        canvas engine: strips, palm filtering, eraser, rendering, export
src/app.ts          toolbar, notes, settings, undo / redo
src/sync.ts         background save queue
src/store/          Supabase and browser storage backends
src/guest.ts        moving notes from "try without an account" into an account
src/auth.ts         sign-in screens
supabase/           database schema
tests/              Playwright tests
docker/, nginx.conf container start-up and security headers
```

## Contributing

Contributions and device reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
