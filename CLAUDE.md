# CLAUDE.md — Pjokk

Pjokk ("en liten pjokk" — a little tyke) is a self-hosted baby tracker for
families, shipped as a Docker container. It is a from-scratch replacement for
sprout-track (https://github.com/Oak-and-Sprout/sprout-track), built mobile-first
as a PWA. Domain: the public marketing + legal site is a separate static
build on the apex, **pjokk.no** (live) — no server, no JavaScript. The app
itself, container and all, lives on **app.pjokk.no**, whose signed-in home
screen is `/home`. Test environment: **test.pjokk.no** (the app host; the
landing site has no separate test deploy).

> **Runtime note (2026-08-28):** the app ran on Cloudflare Workers + D1 + R2 +
> KV through Phase 10. It now runs as a Bun process in a container against
> Postgres and S3-compatible storage. Comments through the codebase that say
> "this used to be X on Workers" are deliberate: they record why a piece of
> code is shaped the way it is.

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
- Bun, one process serving both the SPA (static files) and the API. One
  container image. No CORS in the default setup (same origin).
- Hono for routing. All routes built with `@hono/zod-openapi` — each endpoint's
  zod schema does triple duty: runtime validation, OpenAPI spec, inferred types
  for the RPC client. ONE route tree (no separate "RPC for us / OpenAPI for
  others"). Serve interactive docs with Scalar at `/api/docs`.
- Drizzle ORM + Postgres (`drizzle-orm/bun-sql`, Bun's native client).
  Migrations via drizzle-kit generate → `bun run migrate` from source, or
  `/app/dispatch migrate` in the image. Run as a ONE-OFF job. Never at app startup: drizzle's migrator does not coordinate
  between processes, so replicas would race to apply the same DDL.
- Any S3-compatible store for files (MinIO in compose; S3/R2/Ceph in
  production). Never a public bucket — stream through an authed Hono route
  (`/api/files/:id`). Access it ONLY through
  `apps/api/src/infrastructure/storage.ts`, whose `put` takes `Blob | string`
  and NOT a ReadableStream: Bun's S3 client silently writes the string
  "[object ReadableStream]" if handed one.
- A `rate_limit` Postgres table for rate-limiting counters.
- Scheduled work (reminders, nightly backup) runs via `bun run cron
  <nightly|frequent>` from source, `/app/dispatch cron <job>` in the image. The
  in-process scheduler (`apps/server/src/cron.ts`, opt-in via `SCHEDULER=1`)
  uses Bun's builtin `Bun.cron` with `tz: "UTC"` explicit (the image sets no
  `TZ`, and the 30-day backup retention window is a privacy-policy commitment
  stated in UTC). Under Kubernetes drive it from CronJobs and leave
  `SCHEDULER=0` on every replica; the in-process scheduler is for
  single-container deployments only, because with N replicas it fires every
  job N times.
- Configuration is environment variables, parsed and validated with zod at
  startup (`apps/server/src/env.ts`). Add new settings there, never by reading
  `process.env` at a call site.
- `apps/api` never constructs a dependency at module scope and never reads
  `process.env`; it is a library that receives its collaborators through a
  plain `Deps` object (`apps/api/src/deps.ts`) passed to `createApi(deps)`.
  `apps/server` is the sole composition root: it builds `Deps`
  (`apps/server/src/deps.ts`) from validated config and hands it to
  `createApi`, to `bun run cron`, and to the in-process scheduler. This keeps
  the API testable without a container and, in principle, portable to a
  different host process.

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
- The rate limiter still stores a SHA-256 hash of the client IP rather than
  the address. The original reason (KV was globally replicated and could not
  be pinned) no longer applies now that counters live in the same EU database,
  but there is still no reason to start recording addresses. Keep it that way.
- The privacy policy (`apps/frontend/src/screens/legal/privacy.tsx`) names the
  processors and promises EU storage. **It must be kept in step with where the
  container is actually deployed** — it is a legal statement, not decoration.

**Auth & tenancy**
- better-auth with the **Organizations plugin**. An organization IS a family.
  Members can belong to multiple families; the session's active organization is
  the current family. Roles: parents = `admin` (settings, invites, deletes),
  others = `member` (log + view).
- Social sign-in: Google + email/passkey at launch. Design the login screen to
  accept a third provider button (Apple) without rework — Apple sign-in becomes
  mandatory only if/when a Capacitor App Store build ships.
- **Open signup is DISABLED.** Accounts can only be created through the
  invite-code redeem flow. This is the closed-alpha mechanism.
- Custom invite codes (better-auth org invitations are email-addressed; wrong
  grain for QR-at-Sunday-dinner). Table:
  `family_invite(code, familyId, role, expiresAt, maxUses, usedCount)`.
  Defaults: 72 h expiry, revocable, role baked into the code. Redeem endpoint is
  rate-limited (codes are credentials). Flow: open `https://app.pjokk.no/join/CODE`
  (also rendered as QR) → social sign-in → validate code → addMember → land on
  family home.
- The better-auth instance is built ONCE at startup (`apps/server/src/deps.ts`,
  inside `createDeps`) and handed to requests through Hono context. It used to be per-request
  because D1 bindings only existed inside the handler — which meant every
  request rebuilt a Stripe client and the whole plugin chain. Do not
  reintroduce that.
- Billing is optional: `createStripe` returns null without credentials and the
  stripe plugin is then not registered at all. The SDK throws from its
  constructor on an empty key, so anything that assumes a client exists must
  handle null.
- Enable the better-auth **bearer plugin** from day one (cookies for web,
  bearer tokens for a future Capacitor shell — both coexist).

**Tenancy discipline (non-negotiable)**
- Every domain table carries `familyId` referencing the organization.
- A Hono middleware resolves `familyId` from the session's active organization.
- All Drizzle access goes through family-scoped query helpers. No handler ever
  queries a domain table without the family scope. Enforce from commit one.
- Resources are owned by the family, never the user (this also makes future
  org-level billing inherit cleanly).
- Families have a `plan` column (always `free` for now). One central entitlement
  helper `canUse(family, feature)` — any future gate routes through it; today it
  returns true.

**Frontend**
- Vite + React SPA. TanStack Router + TanStack Query + TanStack Table.
- Forms: react-hook-form + zod (chosen over TanStack Form for shadcn ecosystem
  velocity).
- Charts: shadcn chart components (Recharts underneath). Do NOT use TanStack
  Charts (perpetual beta). Do NOT add TanStack DB or Store now.
- UI: Tailwind + shadcn/ui + vaul for bottom sheets. Mobile-first. Crank touch
  targets well above shadcn defaults on log-flow screens (44 px minimum).
- Hono RPC client (`hono/client`) with a configurable API base URL
  (`''` same-origin on web; overridable for a future native shell).
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

Four tabs: **Home · Timeline · Stats · Settings**. Two sheets (log entry, More).
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

better-auth tables (user/session/account/organization/member/…) + domain:

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

- **Real transactions.** Multi-row atomic writes use `db.transaction()`. D1
  had only `batch()`, which is why several writes were once split into a
  batch plus a separate ownership check, and why invite redemption was
  hand-written SQL with duplicated guards and a compensating DELETE. Those are
  gone; do not reintroduce the pattern.
- **Dialect traps that types cannot catch.** All three of these were live bugs
  during the port:
  - `COUNT()` is bigint, and the driver returns bigints as **strings**. Cast
    raw aggregates: `COUNT(*)::int`.
  - Postgres `real` is 4-byte single precision, unlike SQLite's 8-byte REAL.
    Use `doublePrecision` for anything measured (weights, doses).
  - `timestamptz - integer` is not an operator. Lead times are intervals:
    `start_time - (minutes * interval '1 minute')`.
- **Unique violations** are detected by SQLSTATE `23505` via
  `isUniqueViolation()`, never by matching error text.
- **`user` is a reserved word.** Quote it in any hand-written SQL.
- Timestamps are `timestamptz` everywhere, via the `ts()` column factory.
  Drizzle maps them to JS `Date`, exactly as the old epoch-ms integers did.
- Backups: a nightly row dump to object storage, pruned after 30 days — the
  window the privacy policy commits to for a deletion to take full effect. A
  row dump rather than `pg_dump` so the image needs no Postgres client binary.

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
> **Landing page + apex move (2026-08-27):** the app moved to the apex
> (`pjokk.no`, test `test.pjokk.no`; the `app.` hostnames are retired,
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

- TypeScript strict everywhere. Zod schemas are the single source of truth
  (validation → OpenAPI → client types).
- No `<form>` submission tricks; standard handlers.
- Keep bundle size honest (Workers limits; Drizzle not Prisma partly for this).
- Category color tokens defined once in the Tailwind theme; used by home grid,
  timeline, charts.
- Tests: `bun run test`, run against a REAL Postgres (`docker compose -f
  docker-compose.test.yml up -d`) — the database is the thing most likely to
  differ, so faking it defeats the purpose. Object storage is substituted with
  an in-memory `Storage`. Prioritize the tenancy middleware, invite redeem
  flow, and active-session logic. Each test FILE starts from an empty database;
  rate-limit counters are cleared between individual tests.
- Commit style: small, scoped commits following **Conventional Commits**
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, …). Reference the
  roadmap phase in the body when the work is phase-scoped, e.g.
  `feat(timeline): day-grouped feed` with `Phase 2` noted in the body.

