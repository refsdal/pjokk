<div align="center">
  <img src="public/icon.svg" alt="Pjokk" width="96" height="96" />

  # Pjokk

  **A calm, self-hosted baby tracker for families.**

  *"en liten pjokk" — a little tyke*

  [pjokk.no](https://pjokk.no) · [API docs](https://pjokk.no/api/docs)
</div>

---

## What it solves

New parents look at a tracker far more often than they write to it — usually
one-handed, at 03:00, holding a baby. Pjokk is built around that reality:

- **Status before action.** The home screen answers *"when did she last eat /
  sleep / get changed"* in relative time ("2 h ago"), with zero taps.
- **Five-second logging.** Open sheet → save. Everything is prefilled from the
  last entry; amounts use steppers and chips, never the OS keyboard.
- **Retroactive by default.** Every time field offers *Now / 15 m ago / Pick
  time*, because nobody logs mid-feed.
- **Night mode as a first-class citizen.** Between 22:00 and 07:00 the app
  turns near-black and amber with three big actions in the bottom half of the
  screen — no blue light, no hunting for buttons.
- **A family, not an account.** Caretakers share one family (multi-tenant to
  the bone), join via QR invite codes at the Sunday dinner table, and every
  timeline entry says who logged it. Signup is invite-only.
- **Works in the dead zone.** Offline-first PWA: the last known state renders
  instantly, and entries logged without signal sync when it returns.

It is a from-scratch replacement for
[sprout-track](https://github.com/Oak-and-Sprout/sprout-track), rebuilt
mobile-first and shipped as a single container — one image, a Postgres, and
somewhere to put files.

## How it's built

One Bun process serves the public landing page at `/`, the SPA from `/home`
onwards, and the API under `/api`.

| Layer | Choice |
|---|---|
| Runtime | Bun in a container (one process: static assets + API) |
| API | Hono + `@hono/zod-openapi` — zod schemas drive validation, OpenAPI (Scalar at `/api/docs`), and the typed RPC client |
| Data | Drizzle ORM + Postgres; any S3-compatible store for files (MinIO in the compose stack) |
| Auth | better-auth — Google + email/passkey, Organizations plugin (an organization *is* a family), invite-code redeem as the only signup door |
| Frontend | Vite + React, TanStack Router/Query, Tailwind + shadcn-style components, vaul bottom sheets |
| Offline | TanStack Query persisted to IndexedDB + paused-mutation queue; Workbox PWA with update toast |
| Tests | `bun run test` against a real Postgres — tenancy, invite redeem, and sleep-session logic run against the database they ship on |

Every domain table carries a `familyId`, and all data access flows through
family-scoped query helpers behind a tenancy middleware — cross-family access
is structurally impossible, and tested to stay that way.

## Running it

The whole stack — app, Postgres, MinIO — in one command:

```sh
cp .env.example .env          # set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up             # http://localhost:3000
```

Migrations are applied by a one-off `migrate` service before the app starts,
and the bucket is created by `minio-init`. To create the first account, set
`OPEN_SIGNUP=1`, sign in once, then set it back to `0` — after that, accounts
only exist through invite codes.

### Development

```sh
bun install
docker compose -f docker-compose.test.yml up -d   # database for tests + dev
bun run migrate                                   # apply the schema
bun run seed                                      # demo family, baby Nora, a day of logs
bun run dev:server                                # API on :3000
bun run dev                                       # SPA on :5173, proxying /api
```

Sign in locally with `anders@pjokk.local` / `pjokk-dev`.

```sh
bun run test            # against the Postgres from docker-compose.test.yml
bun run check           # lint + typecheck (shared, api, server, frontend)
bun run build           # build the SPA
```

Configuration is environment variables only — see `.env.example`, which
documents every one. It is validated at startup, so a bad value stops the
process with a message naming the problem rather than surfacing later as a
puzzling 500.

### Deploying

The image runs anywhere a container does. Two rules:

1. **Run migrations as a one-off before the new image serves traffic**
   (`bun migrate.js` inside the image — a Job, an initContainer, or the
   compose `migrate` service). Never at app startup: replicas would race.
2. **Under Kubernetes, leave `SCHEDULER=0`** and drive `bun cron-cli.js
   nightly` and `bun cron-cli.js frequent` from CronJobs. The in-process
   scheduler is for
   single-container deployments; with N replicas it fires every reminder N
   times.

Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies in
front, or the rate limiter cannot tell clients apart. `/healthz` is liveness,
`/readyz` additionally checks Postgres.

### Versioning and images

Versions are computed from [Conventional Commits](https://www.conventionalcommits.org)
since the last `v*` tag — nobody types a version number:

```sh
bun scripts/next-version.mjs        # what would the next release be, and why
```

`feat` bumps the minor, `fix`/`perf` the patch, `!`/`BREAKING CHANGE` the
major. While the major is 0 a breaking change bumps the minor instead, so
reaching 1.0 stays a decision rather than a side effect of a commit message.

CI publishes a **preview** image for every branch and PR — after the smoke
test passes, never before:

```
ghcr.io/refsdal/pjokk:<next-version>-preview.<sha>
ghcr.io/refsdal/pjokk:branch-<branch>
```

The **Release** workflow (manual dispatch, `dry_run` on by default) builds,
pushes `:<version>`, `:latest` and `:sha-<sha>`, then creates the git tag —
in that order, so a failed push never leaves a tag pointing at an image that
does not exist.

## Repository layout

```
packages/shared/  @pjokk/shared   zod schemas — the single source of truth for API shapes
apps/api/          @pjokk/api      Hono API, better-auth factory, tenancy middleware, Drizzle schema
  ├─ migrations/                   Postgres migrations (drizzle-kit)
  └─ test/                         bun tests, run against a real Postgres
apps/server/        @pjokk/server   entrypoints only: main.ts, cron-cli.ts, migrate.ts
apps/frontend/      @pjokk/frontend React SPA (screens, log sheets, offline plumbing) + its tests
```

`CLAUDE.md` is the project constitution (product principles, stack decisions,
roadmap). `DECISIONS.md` logs the boring choices made along the way.
