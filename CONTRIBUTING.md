# Contributing to Lineboard

Thanks for helping! Bug reports, device reports and pull requests are all welcome.

## Device reports are especially useful

Palm rejection depends on what each tablet and browser reports. If you try Lineboard on a device,
open an issue with the device, browser, stylus type, and the "Last contact on page" readout from
Settings for both your stylus and your palm. That data helps tune the defaults.

## Development setup

Requirements: Node.js 20.19 or newer (see `.nvmrc`).

```bash
npm install
npm run dev        # http://localhost:5173, runs in local mode (no backend needed)
```

To work against Supabase, copy `.env.example` to `.env.local` and fill it in (see the README).
To test on a real tablet on your network, run `npm run dev -- --host` and open the printed address.

## Checks

```bash
npm run typecheck
npx playwright install chromium   # first time only
npm test                           # end-to-end tests with simulated touch and palm contacts
```

Please add or update a test in `tests/` when you change input handling.

## Pull requests

- Keep each pull request focused on one change.
- Describe what you changed and how you tested it (the template will prompt you).
- Do not commit secrets. Only the public anon / publishable Supabase key is ever used by the app.
- Database changes go in `supabase/schema.sql` and must keep it safe to re-run, with row-level security on every table.

## Code style

- TypeScript, no UI framework. Keep dependencies minimal.
- 2-space indentation, LF line endings (see `.editorconfig`).
- Plain ASCII in source and docs, except where a symbol is shown to users.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
