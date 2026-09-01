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

Nothing to clone, nothing to build, two containers:

```sh
curl -O https://raw.githubusercontent.com/refsdal/pjokk/main/docker-compose.selfhost.yml

AUTH_SECRET=$(openssl rand -base64 32) \
  docker compose -f docker-compose.selfhost.yml up -d
```

That brings up Postgres and the app on <http://localhost:3000>, with uploaded
files and the nightly backups on a local volume (`STORAGE_DRIVER=fs`) — no
object store to run. The default mode migrates itself under a Postgres
advisory lock before it starts serving, so there is no separate migration step
to wait on.

To create the first account, start it once with `OPEN_SIGNUP=1`, sign in, then
set it back to `0` — after that, accounts exist only through invite codes.
Put `AUTH_SECRET` in a `.env` file next to the compose file so it survives a
restart; **if it changes, every existing session is invalidated.**

Already running Postgres, and want files in a bucket rather than a volume?
Skip the compose file entirely:

```sh
docker run -d --name pjokk -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@host:5432/pjokk' \
  -e APP_URL='https://pjokk.example.com' \
  -e AUTH_SECRET='...' \
  -e STORAGE_DRIVER=s3 \
  -e S3_BUCKET='pjokk-files' \
  -e S3_ENDPOINT='https://s3.eu-north-1.amazonaws.com' \
  -e S3_ACCESS_KEY_ID='...' -e S3_SECRET_ACCESS_KEY='...' \
  ghcr.io/refsdal/pjokk:latest
```

No separate migration step needed — the default mode above applies pending
migrations itself before it starts serving (see [Upgrading](#upgrading) for
why a zero-downtime rollout with several instances still wants the explicit
one-off).

## Self-hosting

The image is `ghcr.io/refsdal/pjokk`, built for `linux/amd64` and
`linux/arm64`. The tags are a pinning ladder — pick how much you want to
move on upgrade day:

| Tag | Moves | Risk appetite |
|---|---|---|
| `:0.1.0` | never | pin exactly, upgrade deliberately |
| `:0.1` | with patch releases | fixes only |
| `:0` | with minor releases | pre-1.0 minors may break — read release notes |
| `:latest` | every release | living on the edge |
| `:sha-<commit>` / `@sha256:…` | never | byte-exact, provenance via cosign |

It
runs anywhere a container does, as one process serving both the SPA and the
API.

Inside it is a single static Go binary on a distroless `static` base: no
shell, no libc, no package manager, nothing to `exec` into — just the CA
bundle, tzdata and the `nonroot` user (uid 65532) maintained upstream. The
SPA, the OpenAPI spec, the SQL migrations and the timezone database are all
compiled into the binary.

### Configuration

Environment variables only, validated at startup — and *every* problem is
reported at once, so a misconfigured container crash-loops with a list rather
than making you fix one variable per restart. **Four are always required:**

| Variable | What it is |
|---|---|
| `DATABASE_URL` | libpq connection string, e.g. `postgres://pjokk:pw@db:5432/pjokk` |
| `APP_URL` | The public origin people type. Sessions are signed and OAuth callbacks are built from it, and an `http://` value also means cookies are issued without `Secure`, so a wrong value breaks sign-in in ways that look like anything except a configuration error |
| `AUTH_SECRET` | `openssl rand -base64 32`, at least 32 bytes. Changing it invalidates every session |
| `STORAGE_DRIVER` | `fs` or `s3` — see below. No default: where a child's health records are written is not a thing to guess |

`STORAGE_DRIVER=fs` then requires `STORAGE_FS_PATH` (the image creates `/data`
owned by uid 65532 so a fresh named volume inherits it). `STORAGE_DRIVER=s3`
requires all four of `S3_BUCKET`, `S3_ENDPOINT` (full URL — required rather
than inferred from a region, because guessing is how data ends up in the wrong
jurisdiction), `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, plus optionally
`S3_REGION` (defaults to `auto`, which is right for R2 and MinIO and wrong for
most managed buckets).

The ones you will most likely also want:

| Variable | Default | Effect |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | `0` | Number of proxies in front. At `0` the rate limiter ignores `X-Forwarded-For`, because it is caller-supplied and trusting it blindly lets anyone mint a fresh bucket per request |
| `OPEN_SIGNUP` | `0` | The founder-bootstrap escape hatch. `1` allows account creation without an invite |
| `PORT` | `3000` | |

`GOOGLE_*` enables Google sign-in and `VAPID_*` enables web push. Absent means
the feature is simply off — the app names the disabled subsystems in its boot
log rather than failing. There is no `STRIPE_*`: Pjokk has no billing, and
every feature is available to every family.
[`.env.example`](.env.example) documents every variable and is the complete
contract — if it is not listed there, the app does not read it.

### Scheduled work

Reminders, the nightly backup and the 30-day backup prune run on two
schedules: `frequent` every 15 minutes, `nightly` at 03:15 UTC. Which dispatch
mode you run decides who does this — there is no separate flag any more:

| Mode | HTTP | Migrates | Scheduler |
|---|---|---|---|
| *(default, no argument)* | yes | yes, under an advisory lock | yes |
| `server` | yes | no | no |
| `worker` | `/healthz` only | no | yes |

**One container:** just run the image with no argument. It migrates itself,
serves the app, and runs the scheduler, all in one process.

**Kubernetes or several replicas:** scale `server` horizontally (it never
migrates and never schedules, so any number of them is safe), and drive the
scheduled work one of two ways:

- One dedicated `worker` replica — same image, argument `worker` — running
  the scheduler and nothing else; or
- CronJobs against the same image, if you would rather not run a persistent
  worker process:

  ```sh
  /app/pjokk cron frequent     # */15 * * * *
  /app/pjokk cron nightly      # 15 3 * * *
  ```

  Set `concurrencyPolicy: Forbid` on both — Kubernetes has no built-in
  guarantee against overlapping runs unless told.

Either way, run at most **one** thing that schedules — two `worker` replicas,
or a `worker` alongside CronJobs, both fire every reminder twice.

### Upgrading

The default mode now migrates itself safely: it takes a Postgres advisory
lock before applying anything pending, so if you run a single `docker compose`
instance, upgrading is just pulling the new image and restarting it — no
separate step needed.

For a zero-downtime rollout with more than one instance (Kubernetes, several
`server` replicas), still **run migrations as an explicit one-off before the
new image serves traffic**, so the schema change lands before any replica
depends on it rather than racing the first replica that happens to start:

```sh
docker run --rm -e DATABASE_URL=... [other required vars] \
  ghcr.io/refsdal/pjokk:<new-version> migrate
```

Under Kubernetes that is a Job or an initContainer. This is safe to run
alongside instances that are still on the old image, and safe to run more
than once — the advisory lock means a `migrate` one-off and a starting
default-mode container can never race each other either.

### Backups

With the scheduler running, the app writes a JSON snapshot of every table to
`backups/YYYY-MM-DD.json` — in your bucket under `STORAGE_DRIVER=s3`, on the
volume under `fs` — each night, and prunes snapshots older than **30 days**,
the window the privacy policy commits to for a deletion to take full effect.

A row dump rather than `pg_dump`, so the image needs no Postgres client binary
(the `scratch` runtime could not run one), and the result stays portable across
whatever runs the database.

The table list is checked against the live schema by a test, in both
directions, so "every table" stays true as the schema grows.

Three things to know before you rely on it:

- **Restores are manual.** There is no restore command. The snapshot is
  `{ exportedAt, tables: { <table>: [rows...] } }` — readable, and insertable
  in foreign-key order, but you are writing that script yourself.
- **Live credentials are nulled out.** Password hashes (`users.password`),
  OAuth access/refresh/id tokens (`accounts.*`) and session tokens
  (`sessions.token`) never reach the snapshot. Thirty days of retained
  backups must not amount to thirty days of usable session cookies. A restore
  therefore loses email/password logins and signs everyone out; Google users
  just re-authorize.
- **The `impersonation` table is skipped entirely**, along with the
  rate-limit counters and the migration bookkeeping. Its rows are pairs of
  live session tokens, and restoring them would be actively wrong rather than
  merely incomplete.

If that is not enough for you, take an ordinary `pg_dump` of the same database
on your own schedule. The two are complementary — and under `fs` the backups
sit on the same volume as the files, which is not off-host storage; copy the
volume somewhere else.

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

Two deploys. The container is one Go process serving the SPA and the API under
`/api` — entirely behind auth, with nothing public to say. The marketing page
and the legal documents are a separate static site, `apps/landing`, published
to the apex with no server and no JavaScript of its own.

| Layer | Choice |
|---|---|
| Runtime | Go 1.27, stdlib `net/http`, no framework. One static CGO-free binary on `scratch`, with the SPA, the spec, the migrations and the tz database embedded in it |
| API | Spec-first: `openapi/pjokk.yaml` is hand-written and authoritative. oapi-codegen generates the strict server, kin-openapi validates every request against the same spec at runtime, and openapi-typescript generates the SPA's client types from it. Scalar docs at `/api/docs` |
| Data | pgx + sqlc (typed Go from plain SQL) + goose migrations, on Postgres. Files through a storage port with two drivers: `fs` (a volume) or `s3` (any S3-compatible store) |
| Auth | [Limen](https://github.com/thecodearcher/limen) — Google + email/password, its Organizations plugin (an organization *is* a family), invite-code redeem as the only signup door. Confined to `internal/auth` behind one interface, with its HTTP routes on an allowlist |
| Frontend | Vite + React, TanStack Router/Query, Tailwind + shadcn-style components, vaul bottom sheets, `openapi-fetch` against the generated schema |
| Offline | TanStack Query persisted to IndexedDB + paused-mutation queue; Workbox PWA with update toast |
| Tests | `go test -p 1 ./...` against a real Postgres — tenancy, invite redeem, and sleep-session logic run against the database they ship on |

Every domain table carries a `family_id`, and the scope is written into the
SQL of every query rather than left to a handler to remember — cross-family
access is structurally impossible, and tested to stay that way.

`internal/api` receives its collaborators: `cmd/pjokk` builds a `Deps` struct
once at startup and hands it to `NewHandler(deps)`. Nothing in the API
constructs a database connection or reads the environment, which is what lets
the suite exercise the whole API in-process without a container.

There is no billing. Every feature is available to every family — a
self-hosted tracker has nobody to bill.

## Development

Two toolchains, because the app is two halves: Go builds the server, Bun
builds the SPA and the landing site. You do not install either by hand —
[mise](https://mise.jdx.dev) pins both (plus the codegen tools `go generate`
expects) in `.mise.toml`, and CI installs from the same file.

```sh
mise install
bun install
docker compose -f docker-compose.test.yml up -d   # Postgres on :55432, for tests and dev

cd apps/server && go run ./cmd/pjokk migrate      # apply the schema
cd apps/server && go run ./cmd/pjokk              # API on :3000 (also migrates, then serves)
bun run dev                                       # SPA on :5173, proxying /api
```

The server needs the same variables the container does — put them in a `.env`
and export it, or pass them inline. For a laptop, `DATABASE_URL` pointing at
the compose database, `APP_URL=http://localhost:3000`, any 32-byte
`AUTH_SECRET`, `STORAGE_DRIVER=fs` and a `STORAGE_FS_PATH` you can write to.

There is no seed script. Start once with `OPEN_SIGNUP=1`, create an account
through the UI, then set it back to `0` — the same bootstrap a self-hoster
does, so it is the path that stays tested.

```sh
cd apps/server && go test -p 1 ./...   # against the Postgres from docker-compose.test.yml
cd apps/server && go vet ./...
bun run test                           # SPA + landing unit tests
bun run check                          # lint + i18n coverage + typecheck
bun run build                          # SPA and the landing site
bun run gen:client                     # regenerate the SPA's types from openapi/pjokk.yaml
```

`-p 1` is not optional: several Go packages truncate shared tables between
tests and cannot run as concurrent packages against one database.

After editing `openapi/pjokk.yaml`, run `go generate ./...` from `apps/server`
(needs `oapi-codegen` v2.8.0 on `PATH`) and `bun run gen:client` from the root.
Generated code is committed; neither CI nor the image runs a code generator.

`docker-compose.yml` runs the locally built image and is the contributor's
stack — run `bash scripts/build-artifacts.sh` first (the Dockerfile is
COPY-only and expects `dist/server/linux/<arch>/pjokk` to exist);
`docker-compose.selfhost.yml` pulls the published image and is the
self-hoster's. They are deliberately separate so a self-hoster never needs the
repository. Both default to `STORAGE_DRIVER=fs`; add the overlay to swap in
MinIO and the `s3` driver:

```sh
docker compose -f docker-compose.yml -f docker-compose.s3.yml up
```

`docker compose run --rm migrate` and `docker compose run --rm cron nightly`
run those one-offs against the same built image (both behind the `tools`
profile, so `up` does not start them).

### Versioning and images

Versions are computed from [Conventional Commits](https://www.conventionalcommits.org)
since the last `v*` tag by [svu](https://github.com/caarlos0/svu) — nobody
types a version number:

```sh
mise x -- svu next --v0             # what the next release would be
```

`feat` bumps the minor, `fix`/`perf` the patch, `!`/`BREAKING CHANGE` the
major. `--v0` keeps a breaking change bumping the minor while the major is
0, so reaching 1.0 stays a decision (the Release workflow's `allow_major`
input) rather than a side effect of a commit message.

CI publishes a **preview** image for every PR — after the smoke test
passes, never before. Preview tags are semver prereleases of the release
they precede, so they always sort below it:

```
ghcr.io/refsdal/pjokk:<next-version>-pr.<number>          # moves with the PR
ghcr.io/refsdal/pjokk:<next-version>-pr.<number>.<sha>    # immutable
```

**Merging to main is releasing:** every merge with releasable commits
(`feat`/`fix`/`perf`/breaking since the last tag) computes the version with
svu, re-runs the full test suite on the merge commit, creates the tag, and
hands everything downstream to [GoReleaser](https://goreleaser.com): binary
archives with checksums and SPDX SBOMs on a GitHub Release with a generated
changelog, the multi-arch image (`:<version>`, `:latest`, `:sha-<sha>`), and
keyless [cosign](https://github.com/sigstore/cosign) signatures over both.
A failed publish deletes the tag again, so a tag never points at a release
that does not exist. Docs/chore-only merges end green without releasing —
nothing app-visible changed. The manual dispatch remains for two levers
only: `dry_run` (the full pipeline as a snapshot, nothing pushed) and
`allow_major` (1.0 stays a human decision). `mise run snapshot` runs the
same pipeline locally.

Images are multi-arch (`linux/amd64` + `linux/arm64`). Building one locally:

```sh
bash scripts/build-artifacts.sh          # SPA + both server binaries, natively
docker build -t pjokk:dev .              # single arch, seconds — COPY-only
bash scripts/build-image.sh              # runs both steps, assembles both arches
TAG=ghcr.io/refsdal/pjokk:v1 PUSH=1 bash scripts/build-image.sh
```

Nothing compiles inside Docker: the SPA and both server binaries are built
natively (the SPA is embedded into the binaries via go:embed), and the
Dockerfile — based on distroless `static` for the CA bundle, tzdata and the
`nonroot` user — only COPYs the binary matching each platform's
`TARGETARCH`. Neither architecture ever runs under QEMU, and the multi-arch
assemble costs seconds. A multi-platform result is a manifest list, which the
local image store cannot hold, which is why the two-arch build without
`PUSH=1` verifies and discards.

### Running without Docker

Every release ships the bare binaries too — the SPA, migrations and tzdata
are embedded, so one file plus Postgres is a complete deployment:

```sh
curl -LO https://github.com/refsdal/pjokk/releases/latest/download/pjokk_<version>_linux_amd64.tar.gz
tar xzf pjokk_<version>_linux_amd64.tar.gz
DATABASE_URL=... APP_URL=... AUTH_SECRET=... STORAGE_DRIVER=fs STORAGE_FS_PATH=/var/lib/pjokk \
  ./pjokk    # migrates itself, serves, schedules — same dispatch modes as the image
```

### Verifying a release

Releases are signed with keyless cosign via GitHub's OIDC — the signature
proves the artifacts came out of this repository's release workflow.

```sh
# 1. The checksum file's signature (covers every archive transitively):
cosign verify-blob \
  --certificate checksums.txt.pem --signature checksums.txt.sig \
  --certificate-identity-regexp 'https://github.com/refsdal/pjokk/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt

# 2. Your download against the verified checksums:
sha256sum --check --ignore-missing checksums.txt

# 3. Or the container image directly:
cosign verify ghcr.io/refsdal/pjokk:<version> \
  --certificate-identity-regexp 'https://github.com/refsdal/pjokk/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Repository layout

```
openapi/pjokk.yaml                  the API contract — hand-written, and the source of both
                                    the generated Go server and the SPA's client types
apps/server/                        the Go module (github.com/refsdal/pjokk/server)
  ├─ cmd/pjokk/                     composition root + dispatch table: default, server, worker,
  │                                 migrate, cron <job>, healthcheck
  └─ internal/
      ├─ api/                       routes, middleware, gen/ (oapi-codegen output)
      ├─ auth/                      the ONLY package that imports Limen, behind auth.Service
      ├─ config/                    every environment variable, validated at startup
      ├─ db/                        queries/ (SQL) → gen/ (sqlc), migrations/ (goose)
      ├─ jobs/                      nightly backup + prune, feed and calendar reminders
      ├─ storage/                   the object-storage port: fs and s3 drivers
      ├─ web/                       static asset serving, security headers, the embedded SPA
      └─ testrig/                   in-process HTTP rig the route tests drive
packages/shared/   @pjokk/shared    the SPA's domain types (no longer describes the wire)
apps/frontend/     @pjokk/frontend  React SPA (screens, log sheets, offline plumbing) + tests
apps/landing/      @pjokk/landing   static marketing + legal site for the apex — see below
```

`apps/server` is a Go module and deliberately *not* a bun workspace: the two
toolchains never call each other, and the Dockerfile is the only place they
meet.

### The landing site (apps/landing)

Separate from the container, and not built or published by it — the Dockerfile
deliberately runs the frontend workspace's own build rather than the root
`bun run build`, so a landing-only render failure never fails the image build
(see DECISIONS.md, "Landing split"). Build it with:

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
