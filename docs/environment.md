# API Environment

The API owns Better Auth, tRPC, Drizzle, UploadThing, GitHub access, Resend email, and AI-powered project suggestions.

## Required In Production

These variables are validated at startup when `NODE_ENV=production`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for Drizzle. |
| `API_BASE_URL` | Public API origin used for auth callbacks and UploadThing callbacks. |
| `WEB_BASE_URL` | Public frontend origin used for auth redirects and trusted origins. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call credentialed API routes. |
| `AUTH_COOKIE_DOMAIN` | Cookie domain for production cross-subdomain auth, usually `oss.now`. |
| `BETTER_AUTH_SECRET` | Better Auth signing secret. |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret. |
| `GITHUB_TOKEN` | GitHub API token used for repo search and public metadata fallback. |
| `RESEND_API_KEY` | Resend API key for verification and reset emails. |
| `AUTH_EMAIL_FROM` | Sender address for transactional auth emails. |
| `UNKEY_ROOT_KEY` | Root key for rate limiting. |
| `UPLOADTHING_TOKEN` | UploadThing token for project logo uploads. |

## Optional

| Variable | Purpose |
| --- | --- |
| `AUTH_EMAIL_REPLY_TO` | Reply-to address for auth emails. |
| `OPENAI_API_KEY` | Enables AI field suggestions during project submission. Missing value is reported as degraded readiness. |
| `UPSTASH_REDIS_REST_URL` | Redis URL for distributed rate limiting. |
| `UPSTASH_REDIS_REST_TOKEN` | Redis token for distributed rate limiting. |

## URLs

| Variable | Local | Production |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:3001` | `https://api.oss.now` |
| `WEB_BASE_URL` | `http://localhost:3000` | `https://oss.now` |
| `CORS_ORIGINS` | `http://localhost:3000` | `https://oss.now,https://staging.oss.now` |
| `AUTH_COOKIE_DOMAIN` | leave unset locally | `oss.now` |

OAuth callbacks are mounted on the API:

| Provider | Local callback | Production callback |
| --- | --- | --- |
| GitHub | `http://localhost:3001/api/auth/callback/github` | `https://api.oss.now/api/auth/callback/github` |

## Readiness

`GET /healthz` returns liveness plus non-secret readiness diagnostics:

- `ready`: whether critical providers are configured.
- `requiredMissing`: required provider env names that are missing.
- `optionalMissing`: optional provider env names that are missing.
- `providers`: GitHub OAuth/token, Resend, UploadThing, and OpenAI status.

Admin dashboards consume the same provider readiness helper, so the UI never needs secret values.

## Checks

Run before deploy:

```sh
bun run typecheck
bun run lint
bun run smoke
bun run db:migrate
```
