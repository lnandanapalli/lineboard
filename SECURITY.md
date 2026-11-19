# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.
Use GitHub's private reporting instead: on this repository, go to **Security -> Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. You should get a reply within a week.

## How Lineboard handles data

- The browser talks directly to Supabase using the public **anon / publishable** key.
  That key is meant to be public; all access control is done by row-level security in `supabase/schema.sql`.
- Every table has row-level security enabled, and each user can only read and write their own rows.
- The `service_role` / secret key must never be used by this app or committed to the repository.
- The Docker image sends a strict Content-Security-Policy and other security headers (`docker/security-headers.conf`).
- Signed-out devices lose access at once, and accounts with two-step verification need it for every request (`access_ok()`).
- Fair-use limits in the database cap how much one account can store; nginx rate-limits each client.
- Optional Cloudflare Turnstile bot check at sign-in and sign-up (`TURNSTILE_SITE_KEY` plus the secret key in Supabase).
- Users can download all their data and delete their account in Settings > Account.

## Supported versions

Only the latest release on the `main` branch receives security fixes.
