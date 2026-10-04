# Contributing to openGym

Thanks for taking a look! openGym is intentionally small and dependency-light, and the goal is
to keep it that way — easy to read, easy to self-host.

## Project layout

```
frontend/  React + Vite app (src/views, src/components, src/store, src/lib). Builds to static files.
           android/ + ios/ are the Capacitor shells for the standalone mobile app (docs/MOBILE.md).
server/    backend — one request handler (handler.js, routes.js), Postgres migrations, no framework.
api/       Vercel function entry (index.js): wires real collaborators into the handler.
scripts/   migrate and local dev API. vercel.json builds the frontend + api together.
media/     exercise img/gif (served from a pinned CDN in production).
docs/      deployment and agent docs; SELF_HOSTING.md is the upstream Docker guide, unused in this fork.
```

## Running for development

```bash
npm install && npm --prefix frontend install
npm run dev:api                   # API on :3000 (local database in .dev-db/, or DATABASE_URL)
npm --prefix frontend run dev     # frontend hot reload on :5173, proxies /api
npm test                          # API tests, through the request handler (server/handler.js)
npm --prefix frontend test        # training logic (progression rules, 1RM, how a session is read back)
```

## Guidelines

- **Keep it dependency-light.** The frontend uses React + Router + Zustand and nothing else;
  new deps (front or back) are a hard sell. The backend has three runtime dependencies
  (`@simplewebauthn/server` for passkeys, `web-push` for notifications, `pg` for Postgres) — keep it
  near that. Test tooling is dev-only (`vitest`, `@electric-sql/pglite` for in-process Postgres).
- **Match the style.** Small components, clear names, comments only where the "why" isn't obvious.
  State lives in the Zustand store (`src/store`); pure helpers in `src/lib`.
- **Don't commit** the exercise media (`media/`) — it's served from a CDN. Never commit `.env*` files or secrets.
- **Test the flow** you touched — click through the affected screens (and the workout flow) in a
  browser before opening a PR.
- **Training logic gets a unit test.** Anything deciding what you lift next, or reading a logged
  session back, belongs in a pure helper in `src/lib` with tests beside it (`npm test`). These
  rules are easy to get subtly wrong and nearly impossible to verify by clicking — the
  progression engine grew two real bugs that only a test pinned down.

## Good first issues

- Additional starter plans (upper/lower, full-body, 5×5…)
- More languages for the exercise instructions (the dataset ships several)
- Percentage / training-max programming (5/3/1-style) on top of the progression engine in
  `src/lib/progression.js` — the policy interface is already there
- Accessibility passes on the workout and chart screens

## Where to ask what

| You have | Goes to |
| --- | --- |
| A question, or self-hosting that won't behave | [Discussions → Q&A](https://github.com/DuarteSantos8/openGym/discussions/categories/q-a) |
| An idea you're not sure about yet | [Discussions → Ideas](https://github.com/DuarteSantos8/openGym/discussions/categories/ideas) |
| A reproducible bug | [Issues](https://github.com/DuarteSantos8/openGym/issues) |
| A change you've already built | A pull request |

An answered question in Q&A is worth more than the same answer buried in a closed issue — the
next person searching "passkey login fails behind my reverse proxy" actually finds it.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and your browser/OS. If it's
about login/passkeys, include your `RP_ID`/`ORIGIN` (not the `data/` contents) — most login
issues are an origin mismatch.

By contributing you agree your work is licensed under the project's [GNU AGPL v3.0](LICENSE).
