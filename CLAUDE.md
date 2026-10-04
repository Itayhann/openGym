## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Itayhann/openGym` (fork of `arvids-unavailable/openGym`, kept as `upstream`); use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Backend

The API is `server/handler.js`: one request handler, with the database, clock, sleep, push sender and config injected. **All server behaviour is tested through it** (`server/test/support/app.js` builds it over real in-process Postgres with a fake clock; `authenticator.js` is a software passkey authenticator). `api/index.js` and `scripts/dev-api.mjs` only wire the real collaborators. Add routes in `server/routes.js` and migrations as the next numbered file in `server/migrations/`.

Commands: `npm test` (API), `npm run test:all` (API + frontend), `npm run dev:api` (local API on :3000, then `npm --prefix frontend run dev`), `npm run migrate`.

The pre-Vercel Node server is in git history (`git show upstream/main:api/server.js`) as the reference when porting a behaviour.
