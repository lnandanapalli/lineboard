# Deployment

The container serves the built site with nginx on port 80 and exposes `/healthz`.
It reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` at start-up and writes them to `/config.js`;
without them the app runs in local mode. Any host that runs Docker images works.
Set `CANONICAL_HOST` (e.g. `example.com`) to send the other spelling of the address (`www.example.com`,
or the reverse) to it with a permanent redirect; leave it unset to serve every hostname.
Set `TURNSTILE_SITE_KEY` to turn on the bot check at sign-in and sign-up, together with the matching
secret key in Supabase (see the README's *Security and abuse protection*).

nginx limits each client to 20 requests per second (bursts up to 100) and answers floods with 429.
Behind Azure App Service the client address comes from `X-Forwarded-For`.

## Included GitHub Actions

| Workflow | Runs on | Does |
| --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | pull requests, pushes to `main` | type-check, Playwright tests, Docker build and smoke test |
| [`release.yml`](../.github/workflows/release.yml) | pushes to `main`, `v*` tags, manual | publishes `ghcr.io/<owner>/<repo>` (`sha-<commit>`, `latest`, version tags), then optionally deploys |

The deploy job only runs when the repository variable `AZURE_WEBAPP_NAME` is set, so forks just publish the image.

## Optional: deploy to Azure App Service

The deploy job signs in with OpenID Connect (no stored secrets) and points the web app at the exact
`sha-<commit>` image it just published.

Azure side:

1. Create a Linux web app that runs the published image, and set its `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` app settings (and `TURNSTILE_SITE_KEY` for the bot check). If both `example.com` and
   `www.example.com` are bound to it, also set `CANONICAL_HOST` to the one you want to keep. Turn on
   **HTTPS Only** (the site sends HSTS).
2. Create a Microsoft Entra app registration with a federated credential for GitHub Actions, entity type
   **Environment**, environment `production`, for your repository.
3. Grant that app registration the **Website Contributor** role on the web app only.

GitHub side, under repository variables (they are identifiers, not secrets):

| Variable | Value |
| --- | --- |
| `AZURE_WEBAPP_NAME` | web app name |
| `AZURE_CLIENT_ID` | app registration's client ID |
| `AZURE_TENANT_ID` | directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | subscription ID |

Recommended: add required reviewers to the `production` environment so each deploy waits for approval.

The GHCR package must be public, or the web app needs registry credentials, to pull the image.
