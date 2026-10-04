# GOAL: openGym, single-owner, in production on the owner's iPhone

## Objective

Take this fork of openGym from its current state to a **production deployment** that the owner uses daily from one iPhone, installed on the home screen. Production means: reachable over HTTPS on a stable hostname, only the owner can sign in, data is backed up, and the owner's phone receives the **Rest alert** and **Daily reminder**.

Vocabulary is the glossary in `CONTEXT.md` (**Profile**, **Passkey**, **Setup code**, **Re-enrolment**, **Active workout**, **Rest alert**, **Daily reminder**, **Home-screen install**). Do not drift to the "Avoid" synonyms.

## Starting point (verified 2026-10-04)

- Already built: passkey auth, per-profile state storage, web push, Rest alert timer, Daily reminder, React/Vite frontend, Dockerfile, `docker-compose.yml`, `render.yaml`.
- Not built: **Setup code** gating the first Passkey, closing registration once a **Profile** exists, **Re-enrolment**. Registration is open to anyone today (`INVITE_ONLY` is off by default).
- No API tests exist. Frontend has vitest tests under `frontend/src/lib/`.
- Tracker: GitHub Issues on `Itayhann/openGym` (`origin`). `upstream` is the unmaintained original: never push there.

## Definition of done

1. A fresh instance cannot be claimed by a stranger: the first Passkey needs the **Setup code**, and registration is closed afterwards.
2. A lost Passkey can be replaced by **Re-enrolment** without losing logged data.
3. API behaviour above is covered by tests at one seam (the real API server driven over HTTP with a software passkey authenticator).
4. `frontend` tests pass, `npm run build` succeeds, and the Docker images build.
5. A production deploy runbook exists and the deploy has been done by the owner: hostname, `RP_ID`/`ORIGIN`, persistent `/data` volume, backup of `/data`, VAPID keys persisted.
6. Verified on the real phone: Home-screen install, sign in with Passkey, log a workout, receive a Rest alert with the app backgrounded, receive a Daily reminder.

## Phases

Each phase ends with its own gate. Do not start the next phase until the gate passes.

| # | Phase | How | Gate |
|---|-------|-----|------|
| 1 | Spec | `/to-spec`: Setup code, closing registration, Re-enrolment. One test seam (API over HTTP). Label `ready-for-agent`. | Spec issue exists on `Itayhann/openGym` |
| 2 | Tickets | `/to-tickets`: tracer-bullet tickets with blocking edges. First ticket also adds the API test harness. | Tickets exist, blockers wired |
| 3 | Build | `/implement <n>` per unblocked ticket, in order, `/tdd` inside, `/code-review` before each commit. Branch per ticket, PR to `origin/main`. | All tickets closed, full test suite + frontend build green |
| 4 | Production readiness | Ticket for deploy hardening: required env vars documented, fail-fast on missing `RP_ID`/`ORIGIN`, `/data` backup instructions, remove the committed-runtime-data risk. | Docker build green, runbook in `docs/` |
| 5 | Ship | Owner-only steps via `/wizard`: hosting account, DNS, env secrets, first Setup code, install on the phone. | Definition-of-done item 6 checked off by the owner |

## Authorisation for this goal

The owner authorised, for this goal only:

- Invoking `/to-spec`, `/to-tickets` and `/implement` directly (the `disable-model-invocation` flag was removed from those three; originals saved as `SKILL.md.orig` next to each). Per-phase "wait for the user to run the next command" no longer applies to them.
- Intent (not yet effective): also invoking `/grill-with-docs`, `/grill-me`, `/triage`, `/wayfinder`, `/handoff`, `/improve-codebase-architecture`, asking the owner the questions from inside the skill. Enabling these was blocked by a permission check; until the owner allows it, they stay user-run.
- Creating issues and labels, pushing branches and opening PRs on `Itayhann/openGym`.

Not authorised, always ask first or hand to the owner:

- Anything on `upstream`.
- Deploying to a host, DNS changes, entering secrets or credentials anywhere, buying a domain.
- Merging PRs, closing issues that aren't ticket-complete, deleting data.

## Open decisions (defaults assumed; owner may override)

- **Hosting:** Docker on a host the owner controls; `render.yaml` suggests Render. Default: keep Docker-based, host-agnostic runbook. A persistent disk is required (JSON file storage in `/data`).
- **Hostname:** passkeys bind to it, so it must be chosen before the first Passkey is registered. Owner decides.
- **Setup code delivery:** default is printed once in the server log at startup on a fresh instance, and a CLI command prints a new one for Re-enrolment.
- **Multi-user and admin dashboard:** left in the code but disabled; not removed in this goal.
- **Android/Capacitor builds:** out of scope; the Home-screen install is the only supported form.

## Status (2026-10-04)

- Phases 1 and 2 done: spec is `Itayhann/openGym#1`, tickets are #2–#11 with blockers wired (#3 and #11 are `ready-for-human`).
- **Design pivot, supersedes the Docker/`/data` assumptions above:** the spec chose Vercel + Neon Postgres at `opengym-itay.vercel.app` (serverless API, Vercel Cron, nightly snapshots instead of `/data` backup, Docker/nginx/Render removed). Read "Definition of done" 4 and 5 and phases 4 and 5 through that lens: "Docker images build" becomes "Vercel build produces frontend + functions", "persistent `/data` volume and backup" becomes "Neon + nightly snapshots", and the runbook is ticket #10.
- Phase 3 in progress, starting with #2. Push only to `origin`; local `main` tracks `upstream/main`, so never use a bare `git push`.

## Working notes

- Skill edits live in the plugin cache and are overwritten by a plugin update; reapply if `/to-spec` etc. become user-only again.
- Update this file when a phase's gate passes (tick the table, note ticket numbers).
