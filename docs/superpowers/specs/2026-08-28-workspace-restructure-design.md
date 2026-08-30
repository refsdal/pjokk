# Bun workspaces, ports & interfaces, landing split — Design

**Date:** 2026-08-28
**Status:** Approved for implementation planning
**Change:** Move the repository from a single `src/` tree to Bun workspaces
(`apps/*` + `packages/*`), introduce an explicit composition root so the API
layer never wires itself, and split the landing page out into its own static
deploy on the apex with the app moving back to `app.pjokk.no`.

## Goals

- **One deployable, explicitly composed.** `apps/api` is a library that
  receives its collaborators; `apps/server` is the only place that constructs
  them. No DI container — a plain `Deps` object passed to `createApi(deps)`.
- **Tests that are cheap to write.** Substituting a collaborator becomes
  passing a different object, not memoizing a `WeakMap` keyed on an env.
- **Boundaries the build enforces.** Package `exports` plus a lint rule, so
  bypassing injection is a build error rather than something a reviewer has to
  notice.
- **Room for a mobile shell** without restructuring again — it consumes
  `@pjokk/api`'s `AppType` exactly as the SPA does.

## Non-goals

- No DI container, no decorators, no service locator.
- No `packages/ui` — the landing site ships zero JavaScript, so there are no
  components for it to share with the SPA.
- No `packages/config` — a root `tsconfig.base.json` and the existing
  `biome.json` cover this without a package.
- No `apps/mobile` placeholder. It gets created when something goes in it.
- No `apps/workers`. The scheduled jobs are use cases over the same `Deps` and
  the same family-scoped queries as the routes, and they are covered by tests
  that live in the api suite. A separate package would import deeply from
  `@pjokk/api` — moving files without decoupling anything — and the workers are
  not a separate deploy target, since a Kubernetes CronJob runs the same image
  with a different entrypoint. This would change if a worker image without the
  HTTP surface is ever wanted; that image would need its own composition root
  and would earn the package.
- No **new** frontend tests. Three existing test files already cover frontend
  code and move to `apps/frontend/test/` — `growth.test.ts`,
  `vaccine-programme.test.ts`, and the `describe("time helpers")` block at
  `test/defects.test.ts:155-174`. Broadening frontend coverage is separate work.
- No behaviour change in pieces 1 and 2. The 25 test files must pass
  unchanged apart from import paths.

## Decisions taken during brainstorming

Two of these reverse earlier decisions recorded in CLAUDE.md. They were made
deliberately, with the consequences enumerated, and the consequences are
carried through this document.

| Decision | Rationale |
|---|---|
| `apps/api`, not `packages/api` | "apps = deployables" does not survive contact with this repo: `apps/frontend` is not independently deployable either — its build output is served by the container. The consistent model here is **apps/ = product surfaces, packages/ = shared support**. |
| Adapters live inside `apps/api`, not in `apps/server` | The property that buys testability is that api never constructs at module scope and never reads `process.env` — not where the adapter file sits. Keeping the Drizzle layer next to the schema also keeps `scoped.ts` covered by the real-Postgres suite, as CLAUDE.md requires. |
| Landing becomes its own static deploy | **Reverses the 2026-08-27 apex consolidation.** Accepted after the trade-offs were laid out. |
| App returns to `app.pjokk.no`; apex serves landing only | DNS-only split, no reverse proxy, no path-routing contract with deployment infra. |
| `/privacy` and `/terms` move to the landing site | They are legal statements that must be readable without an account and without JavaScript. Moving them off the app host also lets the app host be unconditionally `Disallow: /`. |
| `--compile` / distroless deferred to a spike | Answerable, but not by assertion — see piece 4. |
| `now: () => Date` added to `Deps` | Slightly beyond a pure restructure, but this is the natural moment, and it is what makes the reminder and cron tests deterministic instead of clock-dependent. |
| In-process scheduling moves to `Bun.cron` | Retires the hand-rolled 15-minute tick. See "Scheduling" below. |
| `scheduled.ts` splits into `apps/api/src/jobs/` | 337 lines doing four unrelated things; the move is the moment to split them. |

### Consequences of the hostname split that are *not* costs

- `trustedOrigins` stays at **one** entry. The landing site makes no API
  calls — its call to action is a plain link to `https://app.pjokk.no` — so
  the apex never needs to be a trusted origin, and no CORS configuration is
  introduced.
- No shared cookie domain. Session cookies remain scoped to the app host.
- `INDEXABLE` is **deleted** from the server's environment. An app host
  entirely behind auth is unconditionally `Disallow: /`; the landing build
  owns its own indexability.

## Target tree

```
pjokk/
├── package.json              workspaces: ["apps/*", "packages/*"]
├── bun.lock  bunfig.toml  biome.json
├── tsconfig.base.json
├── drizzle.config.ts         → apps/api/src/db/schema.ts, apps/api/migrations
├── docker-compose.yml  docker-compose.test.yml
├── .dockerignore             MUST include **/node_modules
├── scripts/                  seed · import-sprout-track · check-i18n · next-version
│
├── apps/
│   ├── api/                  @pjokk/api       — Hono app as a library
│   ├── server/               @pjokk/server    — the deployable, composition root
│   ├── frontend/             @pjokk/frontend  — the SPA
│   └── landing/              @pjokk/landing   — static site, separate deploy
│
└── packages/
    └── shared/               @pjokk/shared    — zod contracts, domain types
```

## `apps/api` — the library

```
apps/api/
├── package.json
│     exports:
│       "."               → ./src/app.ts          (see re-export note below)
│       "./infrastructure" → ./src/infrastructure/index.ts
├── migrations/                 moved from repo root; lives with the schema
├── src/
│   ├── app.ts                  createApi(deps: Deps); export type AppType
│   │                           re-exports Deps, the ports and Db, so the
│   │                           public entry is self-contained
│   ├── deps.ts                 type Deps
│   ├── ports.ts                Storage · RateLimitStore · Auth · PushSender · PeerAddress
│   ├── context.ts              AppEnv / FamEnv
│   ├── lib.ts                  createApp, jsonContent, isUniqueViolation, serialisers
│   ├── entitlements.ts  billing.ts
│   ├── jobs/                   backup.ts · reminders.ts · calendar-reminders.ts
│   │                           · plans.ts   (was scheduled.ts, 337 lines)
│   │                           bodies only — each takes Deps, nothing schedules
│   ├── db/
│   │     index.ts              type Db            ← type only, no construction
│   │     schema.ts  auth-schema.ts  scoped.ts
│   ├── routes/                 unchanged
│   ├── middleware/             unchanged
│   └── infrastructure/
│         index.ts              re-exports the factories below
│         db.ts                 createDb
│         storage.ts            createStorage      (S3-compatible)
│         auth.ts               createAuth         (better-auth + plugins)
│         stripe.ts             createStripe       (nullable — see CLAUDE.md)
│         rate-limit.ts         createRateLimitStore
│         push.ts               createPushSender
└── test/                       25 integration tests + 4 support files, real Postgres
```

The **type** `Db` lives in `src/db/index.ts`, not in `infrastructure/`. `Deps`
references it and `Deps` is exported from the public entry, so putting the type
behind the restricted entry would force every consumer of `Deps` to import from
`./infrastructure` — defeating the split. Types are safe to expose; only the
*factories* are restricted.

### The `Deps` contract

```ts
// apps/api/src/deps.ts
export type Deps = {
  db: Db
  auth: Auth
  storage: Storage
  rateLimit: RateLimitStore
  push: PushSender
  peerAddress: (req: Request) => string | null
  now: () => Date
  appUrl: string
  vapidPublicKey: string
  stripePriceLifetime: string | null
  trustedProxyHops: number
}
```

Six collaborators and four plain configuration values. The configuration list
is short because an audit of `c.env` across the current server code found only
seven reads — `APP_URL` (7), `INDEXABLE` (3), `VAPID_PUBLIC_KEY`,
`TRUSTED_PROXY_HOPS`, `STRIPE_PRICE_PREMIUM_LIFETIME`, `OPEN_SIGNUP` — and
`INDEXABLE` and `OPEN_SIGNUP` both leave with the landing page.

`peerAddress` is a port rather than a value because the Bun server handle does
not exist until `Bun.serve()` returns. `apps/server` supplies a closure over
its own mutable reference, which removes `PeerAddressSource` from api's public
surface and removes the `Bindings`-must-be-one-long-lived-object hazard
documented in `src/server/context.ts`.

### The Db type

```ts
// apps/api/src/db/index.ts — type only, importable by routes
import type { SQL } from "bun"
import type { BunSQLDatabase } from "drizzle-orm/bun-sql"
import type * as schema from "./schema"

export type Db = BunSQLDatabase<typeof schema> & { $client: SQL }
```

```ts
// apps/api/src/infrastructure/db.ts — construction, server-only
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import * as schema from "../db/schema"
import type { Db } from "../db"

export const createDb = (url: string): Db =>
  drizzle({ client: new SQL(url), schema })
```

The `& { $client: SQL }` is **required**, not decorative. `drizzle()` is
declared as returning `BunSQLDatabase<TSchema> & { $client: TClient }`, so the
bare class annotation drops `$client` — and `test/setup.ts` calls
`db.$client.end()` in `afterAll` because Bun keeps the process alive while the
pool holds handles.

Collapsing `createPool` + `createDb` into a single url-taking factory is
intentional. The seam existed only because there was no composition root; now
that `apps/server` is the single place that constructs, it earns nothing.

### Enforcing the boundary

Adapters sharing a package with routes means nothing structurally prevents a
future route from importing `createDb` and bypassing injection — the same
class of mistake as bypassing the family scope. Two guards:

1. `apps/api/package.json` exports `.` and `./infrastructure` as separate
   entries. Only `apps/server` imports the second.
2. A Biome `noRestrictedImports` rule forbidding `src/routes/**` and
   `src/middleware/**` from importing `../infrastructure/*`.

### What this deletes

- `servicesFor()` and its `WeakMap<Env, Services>` memoization.
- The `inject` middleware in `index.ts` that copies services onto `c.var` per
  request.
- `Bindings` as a carrier of anything. Deps are captured in `createApi`'s
  closure; `AppEnv["Bindings"]` collapses to `{}`.

## `apps/server` — the composition root

```
apps/server/
├── src/
│   ├── env.ts        zod schema, parsed at boot   (was src/server/config.ts)
│   ├── deps.ts       createDeps(env: Env): Deps
│   ├── main.ts       runServer(): Bun.serve · static SPA · SPA fallback
│   │                 · security headers · robots.txt · SIGTERM drain
│   ├── cron.ts       SCHEDULES · runJob(job, deps) · startScheduler(deps)
│   ├── cron-cli.ts   runCron(job): one-shot job runner
│   ├── migrate.ts    runMigrate(): one-off migration job
│   └── dispatch.ts   the compiled binary's entrypoint — one process, four
│                      modes (`/app/dispatch`, `cron <job>`, `migrate`,
│                      `healthcheck`), routing to the exported functions
│                      above via STATIC imports (a dynamic import breaks
│                      module-initialisation order inside a `--compile`
│                      binary — see DECISIONS.md)
├── test/             env parsing (was test/config.test.ts)
└── Dockerfile        build context is the repo root
```

Changes to `env.ts` beyond the move:

- Add `SITE_URL` (`https://pjokk.no`) alongside `APP_URL`
  (`https://app.pjokk.no`).
- **Remove `INDEXABLE`.** `index.ts` serves a fixed
  `User-agent: *\nDisallow: /` and drops the `/sitemap.xml` route entirely.

`index.ts` keeps the ordering the current `main.ts` establishes — app routes,
then static assets, then the SPA fallback, with `/api/*` excluded from the
fallback so a typo'd endpoint returns JSON 404 rather than `index.html` with a
200.

### Scheduling

The hand-rolled 15-minute tick in `src/server/cron.ts` is replaced by
`Bun.cron`, which is a builtin as of Bun 1.4 (verified present in the installed
`bun-types@1.4.0` and at runtime). This retires the reasoning recorded in that
file — *"no cron parser, because a dependency to express them would earn its
keep only if there were more"* — since there is no longer a dependency to
justify.

```ts
// apps/server/src/cron.ts
export const SCHEDULES = {
  nightly: "15 3 * * *",
  frequent: "*/15 * * * *",
} as const

export function startScheduler(deps: Deps): () => void {
  const jobs = (Object.keys(SCHEDULES) as Job[]).map((job) =>
    Bun.cron(
      SCHEDULES[job],
      async () => {
        // Kept INSIDE the callback deliberately — see error semantics below.
        try {
          await runJob(job, deps)
        } catch (error) {
          console.error(`cron: ${job} failed`, error)
        }
      },
      { tz: "UTC" },
    ),
  )
  return () => {
    for (const job of jobs) job.stop()
  }
}
```

**What this fixes.** The current scheduler runs the nightly job on whichever
15-minute tick first lands past 03:15, latched by a day string — so its actual
fire time depends on when the process started. `Bun.cron` fires at 03:15.
It also gives a no-overlap guarantee: the next fire is computed only after the
callback settles, whereas `setInterval` will start a second nightly run
concurrently if the first takes longer than 15 minutes. The nightly job reads
every table and writes a snapshot to object storage, so that is a real latent
bug, not a hypothetical one.

**`tz: "UTC"` is mandatory, not decoration.** The default is the system zone.
`Bun.cron.parse("15 3 * * *", ...)` resolves to `03:15Z` under `UTC` and
`01:15Z` under `Europe/Oslo`. The image does not set `TZ`, so it is UTC by
accident rather than by contract, and the 30-day backup retention window is a
privacy-policy commitment stated in UTC.

**Error semantics invert, and the naive migration is worse than today.**
`Bun.cron` matches `setTimeout`: a rejected promise emits `unhandledRejection`,
and with no listener the process exits with code 1. The job does reschedule
itself after an error, so the correct adaptation is to keep the existing
try/catch inside the callback rather than register a process-wide handler.
Dropping it would turn one transient database blip into a pod restart loop.

**The `SCHEDULER=0` rule is unchanged.** `Bun.cron` in-process fires once per
replica exactly as `setInterval` did. CLAUDE.md's rule — drive scheduling from
Kubernetes CronJobs and leave the in-process scheduler for single-container
deployments — stands verbatim. `SCHEDULES` becomes the shared source of truth
for both paths.

**The OS-level overload is rejected.** `Bun.cron(path, { title })` registers
with crontab/launchd, spawns a fresh process per fire (so there is no shared
connection pool), and requires a cron daemon inside the image — which conflicts
with the distroless target in piece 4 and duplicates what Kubernetes CronJobs
already own.

`runJob(job, deps)` keeps its current shape, taking `Deps` where it took
`Services`. It stays in `apps/server` beside the CLI: api owns what a job does,
server owns when it runs.

### Deployment modes

The three modes a Kubernetes rollout needs are already expressible with the
existing entrypoints and the `SCHEDULER` flag. The restructure carries this
forward unchanged; it is recorded here so the move does not quietly break it.

| Mode | Workload | Command | `SCHEDULER` |
|---|---|---|---|
| Web only, N replicas | Deployment | `/app/dispatch` (default ENTRYPOINT) | `0` |
| Cron only | CronJob | `/app/dispatch cron nightly` / `frequent` | unset |
| All-in-one | Deployment, 1 replica | `/app/dispatch` | `1` |

Three properties make this safe, all of them verified in the current code and
all of them worth preserving deliberately:

- **`SCHEDULER` defaults to `"0"`** (`config.ts:72`, via `z.enum(["0","1"]).default("0")`).
  The unsafe configuration — N replicas each firing every job — requires an
  explicit opt-in. A default of `1` would make a routine scale-to-2 send every
  reminder twice, so the direction of this default is load-bearing.
- **`cron-cli.ts` exits with a status**: `0` on success, `1` on job failure, `2`
  on bad usage, so a failed backup surfaces as a failed CronJob rather than a
  log line nobody reads.
- **The explicit `process.exit(0)` is not redundant.** Bun keeps the process
  alive while the SQL pool holds open handles — the same trap that requires
  `db.$client.end()` in the test suite's `afterAll`. Without the explicit exit,
  a cron-only pod would run the job successfully and then hang until its
  `activeDeadlineSeconds`. Do not "tidy" it away during the move.

The CronJob should additionally set `concurrencyPolicy: Forbid`. The
in-process path gets its no-overlap guarantee from `Bun.cron`; the CronJob path
has no equivalent unless Kubernetes is told.

## `apps/frontend` — the SPA

Straight move of `src/web` plus `index.html` and `vite.config.ts`. Three
changes:

- `@/*` stays as a Vite + tsconfig alias scoped inside the package;
  `@shared/*` becomes a real workspace import of `@pjokk/shared`.
- `lib/api.ts` imports `type { AppType } from "@pjokk/api"` instead of
  `"../../server/index"`.
- The legal routes are removed: `router.tsx:111-124` and `:188`, and the two
  rows at `screens/settings/index.tsx:96,102` become external links to
  `https://pjokk.no/privacy` and `/terms`. `screens/legal/` is deleted.

The dev proxy in `vite.config.ts` keeps pointing at `localhost:3000` — local
development still runs both halves same-origin, so the hostname split is a
deployment property, not a development one.

## `apps/landing` — static site, separate deploy

A Bun build script emitting a complete static site:

```
apps/landing/
├── build.ts            emits dist/
├── src/
│   ├── copy.ts         en + nb strings (moved from src/server/landing/copy.ts)
│   ├── styles.ts       inline CSS tokens (moved)
│   └── pages/
│         landing.ts    render(lang): string   (moved from page.ts)
│         privacy.ts    prose from src/web/screens/legal/privacy.tsx
│         terms.ts      prose from src/web/screens/legal/terms.tsx
├── scripts/gen-og.mjs  moved from repo-root scripts/
└── test/               pure render tests (was test/landing.test.ts)
```

Output:

```
dist/  index.html            nb/index.html
       privacy/index.html    nb/privacy/index.html
       terms/index.html      nb/terms/index.html
       robots.txt  sitemap.xml  og.png  icon.svg
```

Language is resolved at **build time**, one document per language, with
`<link rel="alternate" hreflang>` between them. The `?lang=` → `pjokk_lang`
cookie → `Accept-Language` negotiation is deleted along with the session-cookie
CTA check: the call to action becomes an unconditional link to the app host.

`sitemap.xml` lists the six documents and is emitted unconditionally — the
landing site is always the public one. The `OPEN_SIGNUP` environment flip that
used to change the CTA becomes a landing build flag.

### Data residency

The landing site stores no personal data and no Article 9 data — it is static
marketing copy plus legal text. CLAUDE.md's EU-residency mandate constrains
Postgres, the object store and their backups, none of which the landing host
touches. An EU host is still preferable for access-log hygiene, but it is not
the same obligation and must not be described as one.

The privacy policy remains a legal statement that must track where the
container is actually deployed. Moving it to `apps/landing/src/pages/privacy.ts`
changes the file, not the rule.

## `packages/shared`

`src/shared/schemas.ts` moves unchanged as `@pjokk/shared`. It is imported by
`apps/api` (17 route files plus `db/schema.ts`), `apps/frontend` (36 files) and
the root `scripts/`. It must stay browser-safe: zod and plain types only, no
Bun or Node imports.

## Tests

The 25 test files and 4 support files in `test/` move to `apps/api/test/`,
minus the two noted below. `rig.ts` gets shorter, not
longer — it currently reaches through `servicesFor(env, { storage })` to
substitute an in-memory `Storage`; under the composition root it builds a
`Deps` object directly and hands it to `createApi`. `config.test.ts` follows
`loadEnv` to `apps/server/test/`. `landing.test.ts` follows the landing page
and becomes a pure render test with no HTTP involved.

**Resolved (measured on Bun 1.4.0, 2026-08-28).** `bunfig.toml` is read from
the working directory only: it does not merge with a parent and does not walk
up. Measured behaviour:

| Invocation | Result |
|---|---|
| Root `bunfig.toml`, `bun test` from root | Root preload runs once for the whole run and applies to **every** package's tests. Per-package `bunfig.toml` is ignored. |
| `bun test` from inside a package | That package's own `bunfig.toml` is used, cwd is the package. |
| `bun test` from a package with no `bunfig.toml` | No preload. It does not fall back to the root. |
| No root `bunfig.toml`, `bun test` from root | No preload at all — tests run against an unprepared database. |

A root-level preload is therefore wrong in both directions: it either applies
the api's Postgres setup (schema application plus a `TRUNCATE` in `beforeEach`)
to packages that have no database, or it does not run at all.

**The structure is per-package `bunfig.toml` with the root `test` script
fanning out:** `bun run --filter '*' test`. Verified to give each package its
own cwd and its own preload, and to exit non-zero when any package fails, so
CI stays honest. Note that `--filter` runs packages **concurrently** — safe
here only because `apps/api` is the sole package that touches Postgres. A
second database-touching package would need serialising, since `resetDb()`
truncates every table.

### Distribution of the existing test files

| Destination | Files |
|---|---|
| `apps/api/test/` | 23 test files + `rig.ts`, `helpers.ts`, `memory-storage.ts`, `setup.ts`. Needs `bunfig.toml` with the preload and a live Postgres. |
| `apps/frontend/test/` | `growth.test.ts`, `vaccine-programme.test.ts`, and the time-helper block split out of `defects.test.ts`. No preload, no database. |
| `apps/server/test/` | `config.test.ts` — but only once `loadEnv` moves in PR #16. It stays in `apps/api/test/` for PR #15. |

## Build and image

Piece 1 keeps the current two-stage build: `vite build` for the SPA and a
build stage for the server. (PR #18, "distroless", later replaced the
server's three-bundle `bun build --target=bun` output with a single
`dispatch.ts` compiled via `bun build --compile`, and swapped the runtime
base from Alpine to `gcr.io/distroless/base-debian12:nonroot` — see
DECISIONS.md. Neither change moved the Dockerfile or the build context.) The
Dockerfile **stays at the repo root**. It needs the root as its build context
regardless, because a workspace install needs the root `package.json` and
`bun.lock` plus every member's manifest — and nothing references it by path:
CI and `docker-compose.yml` both rely on the default root location, so moving
it under `apps/server/` would mean adding explicit `-f` flags in several
places and buy nothing. (An earlier draft of this spec said it moves; PR #15
did not move it, deliberately.)

`migrations/` moves under `apps/api/` but is still copied into the image as
data — the migrator reads the SQL at run time, so it is not part of the
compiled binary.

The landing site is a separate CI artifact and is **not** copied into the
container.

## Risks

**`AppType` inference is the highest risk in the whole change.**
`src/server/index.ts` already carries a comment recording that middleware
registered with `.use()` in statement form collapses the accumulated route
types the RPC client derives from the `.route()` chain. Moving that chain
inside `createApi(deps)` and re-deriving `export type AppType =
ReturnType<typeof createApi>` is exactly the shape most likely to silently
degrade to `any` — and it would take the frontend's end-to-end type safety with
it without failing a single test.

Mitigation: land piece 2 with a type-level assertion test that pins a known
route's inferred request and response types, so a widening fails the build.

**Secondary risks**

- The move touches all 134 source files. Keeping piece 1 to `git mv` plus
  mechanical import rewrites — no logic edits — is what keeps it reviewable and
  keeps `git log --follow` working.
- `drizzle.config.ts` and the root `scripts/` both reach into the moved schema;
  their paths must be updated in the same commit as the move.
- Piece 3 changes external configuration this repo does not own. See the
  checklist below.

## Delivery plan

Land PR #14 (the Docker/Postgres port) on `main` first, so the restructure is
diffed against a stable base. Then one PR per piece, each independently
revertable:

| PR | Piece | Character |
|---|---|---|
| #15 | Workspace move | Mechanical. `git mv` + import rewrites + tsconfig/bunfig/Dockerfile paths. No logic changes except the one forced deviation below. |
| #16 | Composition root | Design. `createApi(deps)`, `createDeps(env)`, ports, `infrastructure` entry + lint rule, `WeakMap` deleted, `AppType` assertion test. Includes the `Bun.cron` swap and the `scheduled.ts` → `jobs/` split, since both follow `Services` → `Deps`. |
| #17 | Landing + hostname split | Risky — the only piece that can break production. |
| #18 | `--compile` / distroless | After the spike below. |

Each PR gets its own implementation plan, written when it starts rather than
all four up front — #16's plan depends on what #15's move actually turns up.

**PR #15 is an intermediate state, not the tree above.** To keep it a pure
move, three files stay in `apps/api` and relocate in #16 when `Deps` gives them
somewhere to go: `config.ts` (which `rig.ts` needs, and `apps/api` must not
depend on `apps/server`), `cron.ts`, and `services.ts`. `apps/server` in #15
contains only the three true process entrypoints — `main.ts`, `cron-cli.ts`,
`migrate.ts`. For the same reason `apps/api` ships a wildcard
`"exports": { "./*": "./src/*.ts" }` in #15; the two-entry public/infrastructure
split is designed in #16 rather than guessed at twice.

**One forced deviation from "no logic changes":** `migrate.ts` resolves
`migrationsFolder: "./migrations"` relative to the *working directory*. That
path is correct inside the image (`WORKDIR /app`) but breaks from the repo root
once `migrations/` moves under `apps/api/`. It becomes
`process.env.MIGRATIONS_DIR ?? "./migrations"`, with the root `migrate` script
setting `MIGRATIONS_DIR=apps/api/migrations`. The image leaves it unset and is
unaffected.

The `--compile` spike ran during #16's review and answered these, with
evidence rather than assertion (resolved in PR #18, "distroless" — see
DECISIONS.md):

- **glibc, not musl.** The binary is compiled inside a Debian-based `oven/bun`
  image and runs on `gcr.io/distroless/base-debian12:nonroot`; an
  Alpine-built binary would not link against that base's glibc.
- **No `--asset` embedding.** `migrations/*.sql` and `dist/client` are copied
  into the image as plain files alongside the binary, not embedded in it —
  the migrator and the static-file server both read them from disk at their
  existing relative paths, unchanged.
- **One binary with a subcommand dispatcher** (`dispatch.ts`), not three.
  Static imports only: a dynamic `import()` per branch gets bundled as a
  lazily-initialised chunk, which broke module-initialisation order inside
  the compiled binary and crashed on tsyringe's reflect-metadata polyfill
  (tsyringe arrives via better-auth's passkey support through
  `@peculiar/x509`).
- **The size delta was real but small, and was not the point.** Measured
  ~113 MB against the previous ~118 MB. The reason for the change is the
  absence of a shell, a package manager and `node_modules` in the runtime
  image, i.e. attack surface — not size.

## Out-of-repo checklist for PR #17

These are not code changes and cannot be made from this repository. All must be
done before #17 merges, or sign-in and billing break:

- [ ] DNS: `app.pjokk.no` → the container; `pjokk.no` → the static host.
- [ ] Google OAuth: add `https://app.pjokk.no/api/auth/callback/google` as an
      authorised redirect URI.
- [ ] Stripe: webhook endpoint URL → app host.
- [ ] Stripe: checkout success and cancel URLs → app host.
- [ ] Stripe: Customer Portal return URL → app host.
- [ ] Deploy environment: set `SITE_URL`, update `APP_URL`, remove `INDEXABLE`.
- [ ] Verify the installed PWA on the old origin. Production is a closed alpha
      with a single account, so the blast radius is one device, but the
      `start_url` moves hosts and the old service worker will not follow it.
