<div align="center">
  <img src="apps/landing/public/icon.svg" alt="Pjokk" width="96" height="96" />

  # Pjokk

  **A calm, self-hosted baby tracker for families.**

  *"en liten pjokk" — a little tyke*

  [pjokk.no](https://pjokk.no) · [the app](https://app.pjokk.no) · [API docs](https://app.pjokk.no/api/docs)
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

## Quick start

Nothing to clone, nothing to build:

```sh
curl -O https://raw.githubusercontent.com/refsdal/pjokk/main/docker-compose.selfhost.yml

BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
S3_SECRET_ACCESS_KEY=$(openssl rand -base64 24) \
  docker compose -f docker-compose.selfhost.yml up -d
```

That brings up Postgres, MinIO for files, applies the migrations as a one-off
job, and starts the app on <http://localhost:3000>.

To create the first account, start it once with `OPEN_SIGNUP=1`, sign in, then
set it back to `0` — after that, accounts exist only through invite codes.
Put those two secrets in a `.env` file next to the compose file so they survive
a restart; **if `BETTER_AUTH_SECRET` changes, every existing session is
invalidated.**

Already running Postgres and an S3 bucket? Skip the compose file entirely:

```sh
docker run -d --name pjokk -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/pjokk' \
  -e APP_URL='https://pjokk.example.com' \
  -e BETTER_AUTH_SECRET='...' \
  -e S3_BUCKET='pjokk-files' \
  -e S3_ENDPOINT='https://s3.eu-north-1.amazonaws.com' \
  -e S3_ACCESS_KEY_ID='...' -e S3_SECRET_ACCESS_KEY='...' \
  -e SCHEDULER=1 \
  ghcr.io/refsdal/pjokk:latest
```

Run `docker run --rm ... ghcr.io/refsdal/pjokk:latest migrate` first — see
[Upgrading](#upgrading).

## Self-hosting

The image is `ghcr.io/refsdal/pjokk` — `:latest`, `:<version>`, or
`:sha-<sha>` to pin exactly. It runs anywhere a container does, as one process
serving both the SPA and the API.

### Configuration

Environment variables only, validated at startup — a bad value stops the
process with a message naming the problem rather than surfacing later as a
puzzling 500. **Seven are required:**

| Variable | What it is |
|---|---|
| `DATABASE_URL` | libpq connection string, e.g. `postgres://pjokk:pw@db:5432/pjokk` |
| `APP_URL` | The public origin people type. better-auth signs cookies and builds OAuth callbacks from it, so a wrong value breaks sign-in in ways that look like anything except a configuration error |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. Changing it invalidates every session |
| `S3_BUCKET` | Bucket for vaccine documents and the nightly backups |
| `S3_ENDPOINT` | Full endpoint URL. Required rather than inferred from a region — guessing is how data ends up in the wrong jurisdiction |
| `S3_ACCESS_KEY_ID` | |
| `S3_SECRET_ACCESS_KEY` | |

The ones you will most likely also want:

| Variable | Default | Effect |
|---|---|---|
| `SCHEDULER` | `0` | `1` runs reminders, the nightly backup and its prune in-process. **Leave at `0` under Kubernetes** — see below |
| `TRUSTED_PROXY_HOPS` | `0` | Number of proxies in front. At `0` the rate limiter ignores `X-Forwarded-For`, because it is caller-supplied and trusting it blindly lets anyone mint a fresh bucket per request |
| `OPEN_SIGNUP` | `0` | The founder-bootstrap escape hatch. `1` allows account creation without an invite |
| `PORT` | `3000` | |

`GOOGLE_*` enables Google sign-in, `VAPID_*` enables web push, `STRIPE_*`
enables billing. Absent means the feature is simply off — the app logs which
subsystems are disabled at startup rather than failing.
[`.env.example`](.env.example) documents every variable.

### Scheduled work

Reminders, the nightly backup and the 30-day backup prune run on two
schedules: `frequent` every 15 minutes, `nightly` at 03:15 UTC.

**One container:** set `SCHEDULER=1` and the process runs them itself.

**Kubernetes or several replicas:** leave `SCHEDULER=0` and drive them from
CronJobs against the same image, or every replica fires every reminder:

```sh
/app/dispatch cron frequent     # */15 * * * *
/app/dispatch cron nightly      # 15 3 * * *
```

Set `concurrencyPolicy: Forbid` — the in-process scheduler will not overlap a
run with itself, but Kubernetes has no such guarantee unless told.

### Upgrading

**Run migrations as a one-off before the new image serves traffic.** Never at
startup: replicas would race to apply the same DDL.

```sh
docker run --rm -e DATABASE_URL=... [other required vars] \
  ghcr.io/refsdal/pjokk:<new-version> migrate
```

Under Kubernetes that is a Job or an initContainer; with the compose file it is
the `migrate` service, which already runs before the app starts.

### Backups

With the scheduler running, the app writes a JSON snapshot of every table to
`backups/YYYY-MM-DD.json` in your bucket each night, and prunes snapshots older
than **30 days** — the window the privacy policy commits to for a deletion to
take full effect.

A row dump rather than `pg_dump`, so the image needs no Postgres client binary,
and the result stays portable across whatever runs the database.

Two things to know before you rely on it:

- **Restores are manual.** There is no restore command. The snapshot is
  `{ exportedAt, tables: { <table>: [rows...] } }` — readable, and insertable
  in foreign-key order, but you are writing that script yourself.
- **Password hashes are excluded** from the `account` table on purpose. A
  restore therefore loses email/password logins; Google and passkey users are
  unaffected. That is the deliberate trade — a snapshot in object storage
  should not be a credential database.

If that is not enough for you, take an ordinary `pg_dump` of the same database
on your own schedule. The two are complementary.

### Behind a proxy

`APP_URL` must be the address people actually type, including `https://`.
Set `TRUSTED_PROXY_HOPS` to the number of proxies in front. `/healthz` is
liveness (it touches nothing, so a slow query cannot turn into a restart loop);
`/readyz` additionally checks Postgres and is what a readiness probe wants.

### Where your data lives

Every stateful part — Postgres, the object store, and any backup of either —
holds health information about a child. If that matters to you legally, note
that region selection is now a **deployment-time** choice: pick the region when
you provision the database and the bucket, and check the backup target too. The
nightly snapshot contains every table, so a bucket in the wrong place undoes
the arrangement.

## How it's built

Two deploys. The container is one Bun process serving the SPA and the API under
`/api` — entirely behind auth, with nothing public to say. The marketing page
and the legal documents are a separate static site, `apps/landing`, published
to the apex with no server and no JavaScript of its own.

| Layer | Choice |
|---|---|
| Runtime | Bun, compiled to a single binary on a distroless base — no shell, no package manager, no `node_modules` in the runtime image |
| API | Hono + `@hono/zod-openapi` — zod schemas drive validation, OpenAPI (Scalar at `/api/docs`), and the typed RPC client |
| Data | Drizzle ORM + Postgres; any S3-compatible store for files (MinIO in the compose stack) |
| Auth | better-auth — Google + email/passkey, Organizations plugin (an organization *is* a family), invite-code redeem as the only signup door |
| Frontend | Vite + React, TanStack Router/Query, Tailwind + shadcn-style components, vaul bottom sheets |
| Offline | TanStack Query persisted to IndexedDB + paused-mutation queue; Workbox PWA with update toast |
| Tests | `bun run test` against a real Postgres — tenancy, invite redeem, and sleep-session logic run against the database they ship on |

Every domain table carries a `familyId`, and all data access flows through
family-scoped query helpers behind a tenancy middleware — cross-family access
is structurally impossible, and tested to stay that way.

`apps/api` is a library that receives its collaborators: `apps/server` builds a
`Deps` object once at startup and hands it to `createApi(deps)`. Nothing in the
API constructs a database connection or reads `process.env`, which is what
makes the test suite cheap to write.

## Development

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
bun run check           # lint + typecheck (every package)
bun run build           # SPA, server binary, and the landing site
```

`docker-compose.yml` builds from source and is the contributor's stack;
`docker-compose.selfhost.yml` pulls the published image and is the
self-hoster's. They are deliberately separate so a self-hoster never needs the
repository.

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
pushes `:<version>`, `:latest` and `:sha-<sha>`, then creates the git tag — in
that order, so a failed push never leaves a tag pointing at an image that does
not exist.

## Repository layout

```
packages/shared/   @pjokk/shared    zod schemas — the single source of truth for API shapes
apps/api/          @pjokk/api       Hono API, tenancy middleware, Drizzle schema, jobs
  ├─ infrastructure/                the adapters: db, storage, auth, stripe, push, rate limit
  ├─ migrations/                    Postgres migrations (drizzle-kit)
  └─ test/                          bun tests, run against a real Postgres
apps/server/       @pjokk/server    the composition root: builds Deps once and dispatches to
                                    the web server, cron, migrate or healthcheck mode
apps/frontend/     @pjokk/frontend  React SPA (screens, log sheets, offline plumbing) + tests
apps/landing/      @pjokk/landing   static marketing + legal site for the apex — see below
```

### The landing site (apps/landing)

Separate from the container, and not built or published by it — the Dockerfile
deliberately runs only `build:client` + `build:server`, so a landing-only
render failure never fails the image build (see DECISIONS.md, "Landing split").
Build it with:

```sh
SITE_URL=https://pjokk.no APP_URL=https://app.pjokk.no OPEN_SIGNUP=0 INDEXABLE=1 \
  bun run build:landing
```

Output lands in `apps/landing/dist/` — a plain static tree (HTML, CSS, an icon,
an OG image, `robots.txt`, `sitemap.xml`) to upload to whatever serves the
apex. Four environment variables, all optional (defaults shown):

| Var | Default | Effect |
|---|---|---|
| `SITE_URL` | `https://pjokk.no` | canonical/OpenGraph URLs and hreflang alternates |
| `APP_URL` | `https://app.pjokk.no` | where the sign-in/get-started CTA points |
| `OPEN_SIGNUP` | off (`0`) | CTA copy: "Get started" vs "Sign in" |
| `INDEXABLE` | off (fail-safe: only `"1"` turns it on) | `noindex` meta + `robots.txt` + whether `sitemap.xml` is written at all — leave unset on every host except the production apex |

CI uploads `apps/landing/dist` as a build artifact (see
`.github/workflows/ci.yml`) so a maintainer can download and publish it without
a local build, but nothing deploys it automatically yet.

---

`CLAUDE.md` is the project constitution (product principles, stack decisions,
roadmap). `DECISIONS.md` logs the boring choices made along the way.
