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
- **Account security.** See and sign out signed-in devices, change the password (which signs out other
  devices, as does a password reset), two-step verification with an authenticator app, and passkey sign-in.
  See [Account security](#account-security).
- **Optional end-to-end encryption.** Turn it on in Settings → Privacy & security: ink, note titles and
  notebook names are encrypted on the device before upload. See [End-to-end encryption](#end-to-end-encryption).
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

### Account security

Settings → Sign-in & devices, built on Supabase Auth:

- **Signed-in devices.** Supabase has no client API for listing sessions, so `list_my_sessions()` and
  `revoke_my_session()` in [`supabase/schema.sql`](supabase/schema.sql) expose the user's own rows of
  `auth.sessions` (device from the user agent, IP, last activity). "Sign out all other devices" uses
  `signOut({ scope: 'others' })`.
- **Immediate sign-out.** A restrictive row-level-security policy (`access_ok()`) requires the request's
  session to still exist, so a signed-out device loses access to notes at once instead of when its access
  token expires (up to an hour). The app also re-checks its session when the tab regains focus and every
  five minutes, and returns to the sign-in page.
- **Passwords.** Changing the password needs the current one: the app checks it, and sends it as
  `current_password` so the server checks it too when *Require current password* is on in the project's
  Auth settings. Accounts without a password (email-link or passkey sign-up) confirm with an emailed code
  instead. It signs out other devices by default; so does a password reset from the email link.
- **Confirm it's you.** Adding or removing a passkey or authenticator, and turning encryption on, ask for
  the password (or an authenticator code) if it wasn't entered in the last five minutes, so someone at an
  unlocked device can't add their own way into the account or lock the owner out of their notes.
- **Two-step verification** with any TOTP authenticator app (`auth.mfa`). Several authenticators can be
  added as backups. The same `access_ok()` policy requires `aal2` for users who turned it on, so notes can't
  be read with the password alone even by calling the API directly. Turning it on signs out other devices.
- **Passkeys** (`signInWithPasskey` / `registerPasskey`, supabase-js 2.105+). Enable them in the Supabase
  dashboard under Authentication → Passkeys with your site's domain as the relying party ID; until then the
  passkey card explains they're unavailable and the sign-in button reports the server's error.

In the Supabase dashboard, turn on TOTP under Authentication → Multi-Factor (it is on by default for new
projects) and passkeys under Authentication → Passkeys.

### End-to-end encryption

Encryption is off by default and each user turns it on for their own account in Settings. It uses the
envelope scheme common to password managers, built only on the browser's Web Crypto API
([`src/crypto/`](src/crypto)):

- A random AES-256-GCM **data key** encrypts each stroke, note title and notebook name. The row id is bound
  in as associated data, so ciphertext can't be moved between rows.
- The data key is stored on the server only **wrapped** twice: once by a key derived from the user's
  **encryption passphrase** (PBKDF2-SHA256, 600,000 rounds, random salt) and once by a 160-bit **recovery
  key** shown to the user once. The passphrase is separate from the login password, so a password reset by
  email cannot unlock notes.
- Each device unlocks once; the data key can be kept in IndexedDB as a non-extractable `CryptoKey`
  ("Keep this device unlocked"). Signing out forgets it.
- Turning encryption on (or off) converts existing notes in place. The work is resumable: if the tab is
  closed midway, it finishes the next time the user opens Lineboard.
- Once it is on, row-level security refuses plaintext notes for that user, so an outdated client or another
  device can't silently save unencrypted ink; the app then asks for the passphrase and retries.
- Forgetting the passphrase: unlock with the recovery key and choose a new one. Losing both: the notes cannot
  be recovered by anyone; the user can delete them and start over.

The server still sees metadata: ids, timestamps, which note each stroke belongs to, and ciphertext sizes.
Settings (strip height, pen colours) are not encrypted. Unsaved strokes waiting in the offline queue are kept
in the browser's local storage on the device.

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

## Public pages

New visitors see the homepage at `/` or `/home`. `/login` and `/signup` open separate
account screens when Supabase is configured; `/app` opens the notebook. Returning
local/guest users resume their notes. `/terms` and `/privacy` remain directly accessible.
Navigation uses browser history without reloading the app. The container's nginx
`try_files` fallback serves the app shell for direct visits and refreshes of these paths;
other static hosts need the equivalent SPA fallback. Existing `/#home`, `/#app`, and
other old hash-route bookmarks redirect to the corresponding clean path.

Authentication emails return to the site root (`https://your-site/`), preserving the
existing Supabase redirect allowlist requirement. Auth callback tokens are handled by
Supabase, separately from page routing.

Terms and privacy pages describe the app's current behavior. Before a public launch, the site
operator should review them and confirm hosting-specific retention/privacy information in
`src/public.ts`. They currently identify `@lnandanapalli` and link to GitHub Issues for support;
self-hosters should update those details for their own installation.

## Configuration

To enable accounts and sync, point Lineboard at a Supabase project:

| Docker (read at container start) | Vite dev / build | Value |
| --- | --- | --- |
| `SUPABASE_URL` | `VITE_SUPABASE_URL` | Project URL, e.g. `https://<ref>.supabase.co` (no path) |
| `SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | Anon or publishable key |
| `CANONICAL_HOST` (optional) | (not used) | The one address to serve, e.g. `example.com`. The other spelling (`www.example.com`, or the reverse) gets a permanent redirect to it. |

Serve the app from one address. Browsers keep sign-ins, notes made without an account, the remembered
encryption key and passkey origins separately for `example.com` and `www.example.com`, so set
`CANONICAL_HOST` if both reach the site. The site's platform hostname (e.g. `*.azurewebsites.net`) and
`/healthz` are not redirected.

For development, copy `.env.example` to `.env.local`. Never use the `service_role` / secret key.

### Database

Run [`supabase/schema.sql`](supabase/schema.sql) once in your project (SQL editor or `psql`). It creates the
`notebooks`, `notes`, `strokes`, `user_settings` and `user_keys` tables with row-level security, and is safe to
re-run. **When upgrading, run it again**: until you do, the app keeps working but the encryption switch in
Settings stays unavailable.

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
