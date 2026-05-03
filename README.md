# oss.now API

Standalone backend for oss.now.

## Development

```sh
bun install
bun run dev
```

The API listens on `http://localhost:3001`.

Auth is handled by Better Auth at `/api/auth/*`. Local development uses:

- GitHub callback: `http://localhost:3001/api/auth/callback/github`
- Google callback: `http://localhost:3001/api/auth/callback/google`

If GitHub redirects contain `client_id=` with an empty value, the API was started
without `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Add them to `.env` and
restart `bun run dev`.

Production OAuth callbacks should use the API domain:

- `https://api.oss.now/api/auth/callback/github`
- `https://api.oss.now/api/auth/callback/google`

Email/password verification and password reset emails use Resend. Set
`RESEND_API_KEY` and `AUTH_EMAIL_FROM` in deployed environments. In development,
missing Resend config logs auth links to the API console instead of failing.

`OPENAI_API_KEY` enables AI-assisted project submission suggestions through
AI SDK v6 and `gpt-5.4-mini`. If it is not set, the API falls back to
repository-metadata heuristics so local development still works.

## Endpoints

- `GET /healthz`
- `GET /api/session`
- `GET|POST /api/auth/*`
- `GET|POST /api/trpc/*`
- `GET|POST /api/uploadthing`

Useful tRPC procedures for project submission UX:

- `github.searchRepos`
- `github.suggestProjectFields`

## Docs

- [Environment](docs/environment.md)
- [Project data integrity](docs/data-integrity.md)
