# CLAUDE.md — Pjokk

Pjokk ("en liten pjokk" — a little tyke) is a self-hosted baby tracker for
families, shipped as a Docker container. It is a from-scratch replacement for
sprout-track (https://github.com/Oak-and-Sprout/sprout-track), built mobile-first
as a PWA. Domain: the public marketing + legal site is a separate prerendered
build on the apex, **pjokk.no** (live) — zero JavaScript, and served by the
SAME image in its own dispatch mode (`pjokk landing`), which opens no
database, no auth and no API. There is no second image to publish: the
deployment-specific values are substituted into the prerendered HTML at
startup, not baked in at build time, so one artifact serves the apex, a test
host and a self-hoster's own domain. The static tree remains buildable
(`bun run build:landing`) for anyone who would rather host files. The app
itself lives on **app.pjokk.no**, whose signed-in home screen is `/home`.
Test environment: **test.pjokk.no** (the app host; the landing site has no
separate test deploy).

> **Runtime note (2026-09-01):** the app has had three runtimes. It ran on
> Cloudflare Workers + D1 + R2 + KV through Phase 10; it then ran as a Bun
> process in a container against Postgres and S3-compatible storage; since
> the Go migration the backend is a single static Go binary in a `scratch`
> image, still against Postgres and object storage, with the SPA embedded in
> the binary. Comments through the codebase that say "this used to be X on
> Workers" or "ports `apps/api/src/routes/feeds.ts`" are deliberate: they
> record why a piece of code is shaped the way it is, and which TypeScript
> file each Go file and Go test is answerable to. `apps/api` and
> `apps/server/src/*.ts` no longer exist — a path with `src/` and a `.ts`
> extension in a comment is always history. `apps/server` is the Go module.

## Product principles (read before writing any UI)

1. **Status before action.** The most common use is a glance, not a log. The home
   screen must answer "when did she last eat / sleep / get changed" with zero taps,
   in relative time ("2 h ago", never a bare clock time).
2. **Five-second transactions.** Logging is done one-handed, often in the dark,
   by a sleep-deprived person. Every log flow: open sheet → (adjust) → save.
   The happy path is two taps.
3. **Last-value prefill.** Every log form defaults to the previous entry of that
   type (same amount, same type, time = now). Prefill from the data layer, always.
4. **Retroactive logging is the norm.** People log after the fact. Every time field
   offers quick-offset chips: Now / 15 m ago / Pick time.
5. **Steppers and chips, not keyboards and dropdowns.** Avoid popping the OS
   keyboard. Number steppers for amounts, chip groups for enums.
6. **Night is a first-class theme.** Scheduled night mode (default 22:00–07:00):
   near-black warm background, single amber ramp, no blue light, only three
   actions (Wake / Feed / Diaper), everything in the bottom half of the screen.
7. **Calm, not cute.** One accent color + per-category tints used ONLY on icons
   and badges, never as backgrounds. Category colors: sleep=purple, feeds=blue,
   diapers=teal, growth/measurements=coral.
8. **Attribution is ambient.** Timeline entries show "by <caretaker>" from the
   session. Useful the morning after; free from the auth model.

## Stack (decided — do not substitute)

**Backend**
- Go 1.27, stdlib `net/http` — no web framework. One static, CGO-free binary
  (`apps/server`, module `github.com/refsdal/pjokk/server`) serving both the
  SPA and the API from one process. The SPA, the OpenAPI spec, the SQL
  migrations and the IANA zone database are all `go:embed`ed, which is what
  lets the runtime image be `scratch`. No CORS in the default setup (same
  origin).
- **Spec first.** `openapi/pjokk.yaml` at the repo root is hand-written and
  is the single source of truth. It does triple duty: `oapi-codegen`
  generates the **strict server** interface and types into
  `apps/server/internal/api/gen` (committed — neither CI nor the image runs
  codegen), kin-openapi validates every request against it at runtime as
  middleware, and `bun run gen:client` turns it into
  `apps/frontend/src/lib/api-schema.d.ts` for the SPA. Adding an endpoint
  means editing the YAML and running `go generate ./...` from `apps/server`;
  `internal/api/pjokk.yaml` is a committed copy of the same file that exists
  only because `go:embed` cannot reach above the module root — never
  hand-edit it. Scalar docs at `/api/docs`, behind a session gate.
- pgx v5 (`pgxpool`) + sqlc for queries + goose for migrations. No ORM: the
  queries in `internal/db/queries` are SQL, and sqlc generates typed Go for
  them into `internal/db/gen`. Migrations run via `/app/pjokk migrate`
  (alias `migrations`) in the image, or `go run ./cmd/pjokk migrate` from
  source. The **default dispatch mode also migrates**, at startup, guarded by
  a Postgres advisory lock (`MIGRATION_LOCK_KEY`,
  `apps/server/internal/db/migrate.go`) so several containers booting at once
  serialise instead of racing to apply the same DDL — the first acquires the
  lock and migrates, the rest block and then find nothing pending. `server`
  mode NEVER migrates; it is what replicas run. Orchestrated deployments
  (Kubernetes, several `server` replicas) should still prefer the explicit
  one-off `migrate` before a rollout, ahead of any replica depending on the
  new schema, rather than relying on whichever replica happens to boot first
  — the advisory lock makes that one-off safe to run concurrently with a
  starting default-mode container, it does not make it unnecessary.
- Files go through the `storage.Storage` port
  (`apps/server/internal/storage`), which has **two drivers** chosen by
  `STORAGE_DRIVER`: `s3` (any S3-compatible store — MinIO, S3, R2, Ceph) and
  `fs` (a mounted volume, `STORAGE_FS_PATH`). `fs` is the compose default and
  the reason a self-hoster needs two containers rather than four. Never a
  public bucket — files are always streamed back through an authed route
  (`/api/files/:id`). Access storage ONLY through the port; nothing else
  constructs an S3 client.
- A `rate_limit` Postgres table for the app's own rate-limiting counters.
  (Distinct from `rate_limits`, which is Limen's — see Auth below.)
- Scheduled work (reminders, nightly backup) runs via `/app/pjokk cron
  <nightly|frequent>` in the image, `go run ./cmd/pjokk cron <job>` from
  source. The in-process scheduler (`apps/server/internal/cron`) uses
  `robfig/cron/v3` with the location set to UTC **explicitly** (robfig
  defaults to `time.Local`, the image sets no `TZ`, and the 30-day backup
  retention window is a privacy-policy commitment stated in UTC). There is no
  env flag for this — the dispatch mode expresses it: the default mode and
  `worker` mode both start the scheduler, `server` mode never does (nor does
  `landing`, which starts nothing at all). Under
  Kubernetes, scale `server` for HTTP and drive the scheduled work from
  either CronJobs or exactly one `worker` replica — never more than one thing
  scheduling at once, or every replica/worker fires every job N times.
- Web push is `SherClockHolmes/webpush-go` (VAPID). Absent `VAPID_*` the
  subsystem is simply off and the boot log says so.
- Configuration is environment variables, parsed and validated at startup in
  `apps/server/internal/config`, which reports EVERY problem at once rather
  than failing on the first. Add new settings there, never by reading
  `os.Getenv` at a call site.
- `internal/api` never constructs a dependency and never reads the
  environment; it receives its collaborators through a plain `Deps` struct
  (`apps/server/internal/api/api.go`) passed to `NewHandler(deps)`.
  `cmd/pjokk` is the sole composition root: it builds `Deps` from validated
  config and hands it to the API, to the cron CLI, and to the in-process
  scheduler. This is why the suite can exercise the whole API in-process
  against a real Postgres without a container.
- **No billing.** Stripe, `@better-auth/stripe`, the entitlements module and
  `canUse` are all gone. `organization.plan` survives as a vestigial column
  (values still `free`), but nothing reads it to gate anything: everything
  that was Premium — calendar, contacts, play, API keys, CSV export, the
  growth chart, stats beyond 7 days, vaccine documents — is free. A
  self-hosted tracker has nobody to bill. Do not reintroduce a gate without
  reintroducing a reason.

**EU data residency is mandatory**
- The app stores GDPR Article 9 health data about children. Every stateful
  component — Postgres, the object store, and any backup of either — MUST live
  in the EU.
- This used to be enforced by Cloudflare's jurisdiction flags, which pinned a
  resource at creation and could never be changed. That mechanism is gone: it
  is now a **deployment-time** property, which means it is easier to get wrong
  and nothing will warn you. Whoever provisions the database and the bucket
  owns this guarantee.
- Practically: choose an EU region for the managed Postgres and the S3 bucket,
  and confirm the backup target is EU too. The nightly snapshot contains every
  table, health data included, so a bucket in the wrong region undoes the
  whole arrangement.
- **No component stores a client IP address.** The app's own rate limiter
  keys on a digest, not the address; the original reason (KV was globally
  replicated and could not be pinned) no longer applies now that counters
  live in the same EU database, but there is still no reason to start
  recording addresses. Limen needed the same treatment in two places its
  defaults did record one — its rate-limiter key generator and, less
  obviously, the `ip_address` it writes into every session row's `metadata`
  JSON — so `internal/auth` passes a keyed extractor to both. It is an
  **HMAC**-SHA-256 derived from `AUTH_SECRET` with its own domain separator,
  not a bare digest: the IPv4 space is small enough that an unkeyed hash of
  an address is reversible in seconds and would not be pseudonymisation at
  all. Keep it that way.
- The privacy policy (`apps/frontend/src/screens/legal/privacy.tsx`) names the
  processors and promises EU storage. **It must be kept in step with where the
  container is actually deployed** — it is a legal statement, not decoration.

**Auth & tenancy**
- **Limen** (`github.com/thecodearcher/limen`) with its credential-password,
  oauth/oauth-google and **organization** plugins, replacing better-auth. An
  organization IS a family. Members can belong to multiple families; the
  session's active organization is the current family. Roles: parents =
  `admin` (settings, invites, deletes), others = `member` (log + view).
  Sessions are opaque cookies (`limen_session`); the SPA talks to it through
  `limen-auth/react`.
- **Limen is confined to `apps/server/internal/auth` and reached only through
  the `auth.Service` interface.** Nothing outside that package imports Limen.
  It is a young library and this is the seam that makes replacing it a
  rewrite of one package rather than of the app; it is also where the
  hardening lives. Two rules that must survive any upgrade:
  - **Every Limen dependency is version-pinned**, adapters and plugins
    included. Its HTTP surface and defaults move between releases.
  - **Its HTTP routes are an ALLOWLIST, not a denylist.** Registering the
    plugins mounts ~40 routes, most of which duplicate or contradict Pjokk's
    own API. `internal/auth` disables everything known except credential
    sign-in, Google authorize + callback, signout, the session read, and
    organization create/list/switch (plus signup when `OPEN_SIGNUP=1`).
    `knownRouteIDs` is hand-maintained: an upgrade that adds a route
    upstream would silently enable it, which is why
    `TestLimenRouteAllowlist` probes concrete paths.
- Social sign-in: Google + email/password. Design the login screen to accept a
  third provider button (Apple) without rework — Apple sign-in becomes
  mandatory only if/when a Capacitor App Store build ships. **Passkeys are
  gone**: better-auth's plugin was server-side only and never had UI, and
  Limen has no equivalent, so nothing observable was lost.
- **Open signup is DISABLED — but the guarantee is no ACCESS without an
  invite, not no ACCOUNTS.** OAuth account creation (Google) stays open even
  under closed signup: it is the only way a brand-new invitee can get the
  account they need to redeem an invite, since Limen has no per-invite
  signup gate. Credential signup, by contrast, is the founder-bootstrap
  escape hatch and is gated on `OPEN_SIGNUP` directly. What actually keeps
  the alpha closed is family creation: an uninvited OAuth account cannot
  create an organization (`allowOrgCreation` requires `OPEN_SIGNUP` or
  sysadmin) or reach any family route, so it cannot be parlayed into an
  unlimited supply of families — it can only sit inert until it redeems an
  invite or is removed by the orphan-account purge.
- Custom invite codes (Limen's org invitations, like better-auth's, are
  email-addressed; wrong grain for QR-at-Sunday-dinner). Table:
  `family_invite(code, familyId, role, expiresAt, maxUses, usedCount)`.
  Defaults: 72 h expiry, revocable, role baked into the code. Redeem endpoint is
  rate-limited (codes are credentials). Flow: open `https://app.pjokk.no/join/CODE`
  (also rendered as QR) → social sign-in → validate code → addMember → land on
  family home.
- The Limen instance is built ONCE at startup, in `cmd/pjokk`'s composition
  root, and handed to handlers through `Deps`. It used to be per-request under
  Workers because D1 bindings only existed inside the handler — which meant
  every request rebuilt the whole plugin chain. Do not reintroduce that.
- **API keys are our own table**, not an auth-library plugin: `api_key`
  (`pjk_` bearer tokens, SHA-256 at rest, read-only flag, family-scoped) for
  Home Assistant / Grafana. Cookies for web, bearer keys for integrations, and
  a future Capacitor shell reuses the same header path.

**Tenancy discipline (non-negotiable)**
- Every domain table carries `family_id` referencing the organization.
- `internal/api/middleware` resolves the family from the session's active
  organization and puts it on the request context; a route that needs one is
  wrapped in `RequireFamily` (403 `NO_FAMILY` otherwise).
- **Every sqlc query on a domain table takes `family_id` in its WHERE
  clause** — the scope lives in the SQL, not in a handler's discipline. No
  handler ever queries a domain table without it. Enforce from commit one.
- Resources are owned by the family, never the user.
- Families have a `plan` column, always `free`. It is vestigial: there is no
  `canUse`, no entitlements module, and no 402. Every feature is available to
  every family (see "No billing" above).

**Frontend**
- Vite + React SPA. TanStack Router + TanStack Query + TanStack Table.
- Forms: react-hook-form + zod (chosen over TanStack Form for shadcn ecosystem
  velocity).
- Charts: shadcn chart components (Recharts underneath). Do NOT use TanStack
  Charts (perpetual beta). Do NOT add TanStack DB or Store now.
- UI: Tailwind + shadcn/ui + vaul for bottom sheets. Mobile-first. Crank touch
  targets well above shadcn defaults on log-flow screens (44 px minimum).
- API client: `openapi-fetch` over `apps/frontend/src/lib/api-schema.d.ts`,
  which `bun run gen:client` generates from `openapi/pjokk.yaml` (it replaced
  the Hono RPC client, which could only exist while the server was
  TypeScript). Configurable base URL (`''` same-origin on web; overridable
  for a future native shell). `lib/api.ts`'s `unwrap` adapts openapi-fetch's
  `{ data, error }` result back to the throw-`ApiError` shape every call site
  expects. The generated `.d.ts` is committed and excluded from biome —
  reformatting it would make regeneration a diff.
- Offline: `persistQueryClient` to IndexedDB (timeline renders instantly
  offline) + paused mutations that queue and auto-resume. Logging a feed with
  no signal must not fail.
- PWA from day 1: `vite-plugin-pwa` + Workbox. Precache app shell, NetworkFirst
  for API GETs, NEVER cache auth endpoints or mutations. Implement an "update
  available" toast wired to registerSW (no silent stale versions).
- `viewport-fit=cover` + `env(safe-area-inset-*)` padding from the start.
- Push subscription logic behind a small interface (web push now; native push
  token later is a second implementation of the same interface).

**Locale (Norwegian defaults, quietly)**
- Units: ml, grams/kg. 24-hour clock. Monday week start. `nb-NO` formatting via
  `Intl` from the first commit.
- Pipe every user-facing string through a `t()` helper now; actual translation
  (English/Norwegian) comes later. Default UI language: English for now.

## Information architecture

Five tabs: **Home · Timeline · Stats · Calendar · Settings**. Two sheets (log
entry, More).
No FAB, no swipe navigation (fights PWA back-gesture), no onboarding tutorials
(the invite flow IS onboarding).

- **Home:** baby header w/ age + caretaker chip (avatar → family switcher),
  active-session banner (live counter + Wake button when sleeping), last-feed /
  last-diaper status cards, 2×2 grid of big log buttons (Feed, Diaper, Sleep,
  More), tab bar.
- **Log sheets (vaul):** type chips → prefilled stepper/fields → time chips
  (Now / 15 m ago / Pick time) → full-width Save at the very bottom. The SAME
  component handles create and edit.
- **Timeline:** day-grouped feed, dense ~44 px rows with hairline dividers (not
  cards), per-category icon + tint, sleep rows show spans + duration, "active"
  badge for running sessions, "by <name>" attribution, day-summary line
  ("6 feeds · 3 naps · 5 diapers"), filter chips (All/Feeds/Sleep/Diapers).
  Tap row → edit sheet.
- **Stats:** deliberately minimal at first — avg sleep/day, avg intake/day,
  one bar chart (sleep per day, week/month toggle), weight row w/ percentile
  teaser. WHO growth reference data ships as bundled static JSON (no API).
- **Settings:** iOS-style grouped rows. Family (Babies, Caretakers, Invite
  link w/ QR), Preferences (Notifications, Units, Night mode schedule), Data
  (Export CSV, API access).
- **Night mode:** scheduled + manual override; deliberate exit gesture.
- **Active sessions are state, not screens:** one `activeSession` query,
  rendered everywhere (home banner, timeline badge, tab tint).

## Data model (Phase 1 core)

Limen tables (`users`/`sessions`/`accounts`/`organizations`/
`organization_members`/`organization_member_roles`/`verifications`/
`rate_limits`/`organization_invitations`) + domain. Note the plural table
names and the join-table roles: these are Limen's shapes, verified against
the library rather than guessed, and they are NOT the better-auth names the
Bun-era schema used. Domain tables kept their singular names:

- `baby(id, familyId, name, birthDate, …)`
- `sleep_log(id, familyId, babyId, caretakerId, startTime, endTime NULL while
  active, location?, notes?)`
- `feed_log(id, familyId, babyId, caretakerId, time, type bottle|breast|solids,
  amountMl?, side?, durationMin?, notes?)`
- `diaper_log(id, familyId, babyId, caretakerId, time, type wet|dirty|both,
  notes?)`
- `family_invite(code, familyId, role, expiresAt, maxUses, usedCount)`
- Organization/family metadata: `plan` (default `free`), units, night-mode
  schedule.

Later phases add: medicine (+units), bath, note, milestone, measurement
(weight/length/head), pump. These are structural copies of the Phase 1 CRUD +
sheet pattern — build the pattern well once.

## Postgres notes (respect these)

- **Real transactions.** Multi-row atomic writes use `pgx`'s `Begin`/`Commit`
  (`pool.BeginTx`, with the sqlc `Queries` bound to the transaction via
  `WithTx`). D1 had only `batch()`, which is why several writes were once
  split into a batch plus a separate ownership check, and why invite
  redemption was hand-written SQL with duplicated guards and a compensating
  DELETE. Those are gone; do not reintroduce the pattern.
- **Dialect traps that types cannot catch.** All three of these were live bugs
  during the Bun-era port and are still true:
  - `COUNT()` is bigint. sqlc types it `int64` in Go, but cast raw aggregates
    to `::int` where the API contract is an int.
  - Postgres `real` is 4-byte single precision, unlike SQLite's 8-byte REAL.
    Use `double precision` for anything measured (weights, doses).
  - `timestamptz - integer` is not an operator. Lead times are intervals:
    `start_time - (minutes * interval '1 minute')`.
- **Unique violations** are detected by SQLSTATE `23505` (a `*pgconn.PgError`
  with `Code == "23505"`), never by matching error text.
- **`user` is a reserved word** — the reason Limen's table is `users`. Quote
  any identifier that collides.
- Timestamps are `timestamptz` everywhere and map to Go `time.Time`, exactly
  as they mapped to JS `Date` before, and to epoch-ms integers before that.
- Backups: a nightly row dump to object storage, pruned after 30 days — the
  window the privacy policy commits to for a deletion to take full effect. A
  row dump rather than `pg_dump` so the image needs no Postgres client binary
  (the `scratch` runtime could not run one anyway). Two deliberate
  subtractions: **live credential columns are nulled before the dump**
  (`users.password`, `accounts.access_token`/`refresh_token`/`id_token`,
  `sessions.token`) — thirty days of retained snapshots must not amount to
  thirty days of valid session cookies — and the `impersonation` table is
  excluded outright, because every one of its rows is a pair of live session
  tokens and there is nothing else in it worth restoring.
  `jobs.DeliberatelyExcluded` names it alongside the two rate-limit tables
  and goose's bookkeeping, and `backup_tables_test.go` checks the list
  against the live schema **in both directions**, so "every table" stays
  true as the schema grows.

## Phased roadmap

> **Status (2026-08-24): Phases 1–4 SHIPPED** to https://pjokk.no
> (custom domain; workers.dev is off; Refsdal Holding AS account). Phase 2 delivered the day-grouped timeline (merged
> `/api/timeline` endpoint with before-cursor pagination), edit/delete
> through the same log sheets (incl. the notes field), filter chips, day
> summaries, and dark mode (system/light/dark — night mode still overrides).
> Phase 3 delivered the six extra activity types (medicine, bath, note,
> milestone, measurement, pump) as ONE generic CRUD + route factory
> (`scoped.ts logCrud` / `routes/other-logs.ts makeLogRoutes`) and ONE
> dispatcher sheet (`OtherLogSheet`), reachable from the More button and the
> timeline's new Other filter. Phase 4 delivered the Stats tab (avg
> sleep/intake per day, sleep-per-day bar chart w/ week/month toggle —
> recharts lazy-loaded — and a weight row with trend; percentile deferred to
> Phase 7, needs a baby sex field + WHO LMS data) and CSV export under
> Settings → Data (`GET /api/export.csv`). Phase 5 delivered web push
> (web-push pkg verified working under nodejs_compat; VAPID secrets;
> subscription lifecycle w/ 410 pruning), per-caretaker feed reminders
> (off/3/4/6 h, one nudge per gap, */15 cron), the nightly D1 → R2 JSON
> backup (03:15 UTC cron), a configurable night-mode schedule, and the
> Settings → Notifications section (enable/disable device, test push).
> Phase 6 delivered the full Tabler icon swap: lucide-react is gone, all
> icons are @tabler/icons-react (Feed=baby-bottle, Diaper=diaper,
> Pump=milk; the attached-note indicator and the Note activity now share
> IconNote deliberately). Phase 7 (partial) delivered WHO growth
> percentiles + growth chart (baby.sex field, bundled WHO LMS JSON,
> client-side math), Norwegian translation (auto-from-device + manual
> toggle; dictionary in lib/i18n.ts), and read+write API keys for
> HA/Grafana (pjk_ bearer keys, Settings → API keys). Still on the
> Phase 7 backlog: PDF report, kiosk/PIN mode, Capacitor shell.
> Phase 8 delivered the system-admin console at /admin (better-auth admin
> plugin; user.role === "admin" ≠ family roles): platform stats, family
> overview + cascade delete, user support (sessions/password/ban/delete),
> impersonation with an in-app banner, and an append-only admin_audit
> trail. Phase 9 delivered Stripe billing via @better-auth/stripe, org-level
> subscriptions AND org-level Stripe customers (users pay, families are
> Premium; any family admin manages billing). `organization.plan` is one of
> free/premium/lifetime/comp: webhooks flip free↔premium, a one-time
> checkout grants lifetime, comp is an audited sysadmin override
> (free/comp only — Stripe-derived values are webhook-only). Soft-lock
> gates (402 PLAN_REQUIRED) sit on API key creation + consumption, CSV
> export, and stats beyond a 7-day window; the growth chart is client-gated.
> Settings → Billing offers monthly/yearly subscribe (plugin checkout),
> lifetime (custom mode:payment route), and the Stripe Customer Portal for
> self-service management. Admin gained an audited comp override and
> cancels a family's subscription on cascade delete. Admin billing tools
> (revenue/subscription visibility) and coupons remain the post-Phase-9
> backlog.
> Also already in place ahead of schedule: night mode (scheduled + manual),
> minimal Settings (members, invite link w/ QR + revoke, night mode, sign
> out), PWA update toast, offline persist + paused-mutation queue.
> Deviations & boring choices are logged in DECISIONS.md — notably:
> passkey plugin is server-side only (no UI yet), email/password sign-IN is
> enabled as the dev/demo path (signup stays closed), log sheets omit the
> notes field until the edit sheet lands in Phase 2, and Google OAuth
> credentials are still placeholders (see SMOKE-TEST.md for go-live steps).
> Post-Phase-9: the premium Calendar shipped — fifth tab (month/week grid +
> upcoming list), family-wide events with multi-baby + multi-assignee chips,
> category tints reusing the existing tokens, 402-gated creation
> (edit/delete stay open per the soft-lock rule), and calendar push
> reminders on the */15 cron with a remindedAt latch + 60-min grace window.
> Phase 10 (2026-08-27) closed the biggest sprout-track migration gaps:
> **Contacts** (premium) — family address book under Settings → Family,
> shared across babies via a contact_baby join table where zero rows means
> the whole family; **Play** (premium) — tummy time / walk / play with
> server-side timers built as a sleep_log clone (end_time IS NULL =
> running, partial unique index, activePlay on /api/summary, running
> banner on Home), no Durable Object; **Vaccines** (free log, premium
> documents) — the bundled barnevaksinasjonsprogrammet as a reference
> overlay at /vaccines, plus the first real R2 file path
> (`/api/files/:id`, allowlisted images+PDF, 10 MB, 5 per entry,
> attachment-only). The sprout-track importer gained mappings for all
> three and stopped silently dropping TBSP amounts, DRY diapers, sleep
> type/quality, diaper detail, feed reaction fields and calendar events.
> **Landing page + apex move (2026-08-27):** — SUPERSEDED on the hostname
> point: the landing split later un-retired `app.pjokk.no` (the app lives
> there again; the apex serves the static landing site — see DECISIONS.md
> "Supersedes" entry). Historically: the app moved to the apex
> (`pjokk.no`, test `test.pjokk.no`; the `app.` hostnames were retired,
> workers.dev off, `trustedOrigins` down to one) and the signed-in home
> screen moved from `/` to `/home`. `/` is now a public landing page
> rendered BY THE WORKER — one self-contained document, inline CSS, zero
> JavaScript, no app bundle — which required adding `"/"` to the assets
> `run_worker_first` list. Language is negotiated server-side (`?lang=` →
> `pjokk_lang` cookie → `Accept-Language`), and the call to action is
> derived from a session-cookie presence check plus `OPEN_SIGNUP`, so
> opening signup is an env flip rather than a code change. The mock-up in
> the hero is a CSS animation, deliberately conceptual rather than the real
> components. A new `INDEXABLE` var gates `robots.txt`, `sitemap.xml` and
> the noindex headers so only production is crawlable.
> **Docker/Postgres port (2026-08-28):** the app left Cloudflare entirely.
> Bun in a container replaces Workers; Postgres replaces D1; S3-compatible
> storage replaces R2; a `rate_limit` table replaces KV; `bun run cron`
> replaces cron triggers. `src/worker` is now `src/server`, the package
> manager is bun, and the suite is `bun test` against a real Postgres (200
> green). Deliverables: `Dockerfile`, `docker-compose.yml` (app + Postgres +
> MinIO, with one-off `migrate` and `minio-init` services),
> `docker-compose.test.yml`, `/healthz` + `/readyz`, and a one-shot cron CLI
> so a Kubernetes CronJob runs the same image. No production data was
> migrated — the port started from an empty database. `robots.txt`,
> `sitemap.xml` and the security headers moved from build time to runtime, so
> ONE image now serves both test and production. Bugs the port surfaced and
> fixed: single-precision `real` rounding recorded weights, `COUNT()` served
> as a string, SQLite-worded unique-violation detection, epoch-ms interval
> arithmetic, an unconditional Stripe client that crash-looped without
> credentials, and a rate limiter that silently degraded to one shared bucket
> behind an ingress.
>
> **Go migration (2026-09-01):** the backend was rewritten in Go and the
> TypeScript one deleted. `apps/api` + `apps/server` (Bun, Hono,
> `@hono/zod-openapi`, Drizzle, better-auth, Stripe) are gone; `apps/server`
> is now a Go module producing one static binary that embeds the SPA, the
> spec and the migrations, shipped from a `scratch` image built for amd64 and
> arm64. What changed in kind, not just in language: the OpenAPI document
> flipped from generated to **hand-written and authoritative**
> (`openapi/pjokk.yaml` → oapi-codegen strict server + runtime request
> validation + the SPA's client types); Drizzle became sqlc + goose over pgx;
> better-auth became **Limen**, confined behind `internal/auth`'s
> `auth.Service` with a route allowlist; the object store gained an **`fs`
> driver** so a self-hoster needs two containers, not four. **Billing was
> dropped entirely** — no Stripe, no entitlements, no 402: every feature that
> was Premium is free, `organization.plan` is vestigial. Passkeys went with
> better-auth (server-side only, no UI, nothing observable lost). The cutover
> was a **fresh database** — no data was migrated, the schema is Limen-shaped
> and differs from the better-auth one — and the dispatch modes, the advisory
> -lock migrate semantics and the 30-day backup window are all unchanged. The
> suite was ported test-for-test: every Go test file names the `apps/api`
> test it descends from.

1. **Core loop:** schema, auth (social + orgs + invite codes), tenancy
   middleware, home screen with status cards + Feed/Diaper/Sleep sheets,
   active sleep session. This alone replaces 80 % of daily usage.
2. **Timeline:** day-grouped feed, edit/delete via the same sheets, filters,
   day summaries, dark mode.
3. **More activity types:** medicine, bath, note, milestone, measurements,
   pump (repeat the Phase 1 pattern).
4. **Calendar/Stats + export:** stats tab, CSV export (skip xlsx).
5. **Push + PWA polish:** web push (VAPID), subscription lifecycle (cleanup on
   410), per-caretaker notification prefs, Cron reminders, night mode schedule,
   update toast. iOS web push works for installed PWAs.
6. **Tabler icons:** replace ALL icons so the app exclusively uses Tabler
   icons (`@tabler/icons-react`), dropping lucide-react entirely. Tabler has
   literal `diaper` and `baby-bottle` glyphs (lucide has neither); pairing:
   Feed = `baby-bottle`, Pump = `milk`. Same 24×24 / 2px-stroke style, so it's
   a mechanical swap in the icon maps (`otherKindMeta`, `kindStyle`, home grid)
   plus any stray UI icons.
7. **Nice-to-haves:** WHO growth curves, client-side PDF report (jsPDF — never
   server-side), API keys for Home Assistant/Grafana, kiosk/PIN mode for a
   shared nursery tablet, Norwegian translation, Capacitor shell if ever needed.

## Engineering conventions

- Two languages, one repo. Go for the server (`apps/server`, its own module,
  outside the bun workspace); TypeScript strict for everything else. Neither
  toolchain runs the other's build — `bun run build` produces the SPA and the
  landing site, `go build ./cmd/pjokk` produces the server, and the Dockerfile
  is the only place both meet.
- `openapi/pjokk.yaml` is the single source of truth for API shapes
  (validation → generated Go server → generated TS client). `packages/shared`
  is now only the SPA's domain types, and no longer describes the wire.
- No `<form>` submission tricks; standard handlers.
- Keep bundle size honest — the SPA is embedded in the binary, so it is also
  image size.
- Category color tokens defined once in the Tailwind theme; used by home grid,
  timeline, charts.
- Tests, both halves against a REAL Postgres where a database is involved
  (`docker compose -f docker-compose.test.yml up -d`, which publishes 55432)
  — the database is the thing most likely to differ, so faking it defeats the
  purpose:
  - `cd apps/server && go test -p 1 ./...` — **`-p 1` is required**: several
    packages truncate shared tables between tests and are not safe to run as
    concurrent packages against one database. Object storage is substituted
    with an in-memory `Storage`. Prioritize the tenancy middleware, invite
    redeem flow, and active-session logic.
  - `bun test apps/frontend apps/landing` (or `bun run test`) — the SPA's own
    unit tests and the landing site's render tests. No database.
  - `bun run check` is lint + i18n coverage + typecheck for the TypeScript
    side; `go vet ./...` for the Go side.
- Commit style: small, scoped commits following **Conventional Commits**
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, …). Reference the
  roadmap phase in the body when the work is phase-scoped, e.g.
  `feat(timeline): day-grouped feed` with `Phase 2` noted in the body.

