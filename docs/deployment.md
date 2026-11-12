# Deployment

The container serves the built site with nginx on port 80 and exposes `/healthz`.
It reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` at start-up and writes them to `/config.js`;
without them the app runs in local mode. Any host that runs Docker images works.

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
   `SUPABASE_ANON_KEY` app settings.
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
