# CLAUDE.md — Pjokk

Pjokk ("en liten pjokk" — a little tyke) is a self-hosted baby tracker for families,
running entirely on Cloudflare Workers. It is a from-scratch replacement for
sprout-track (https://github.com/Oak-and-Sprout/sprout-track), built mobile-first
as a PWA. Domain: the app lives at **app.pjokk.no** (live); the pjokk.no apex
is reserved for a separate landing page that only links to the app.

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
- Cloudflare Workers, single Worker serving both the SPA (static assets binding)
  and the API. One `wrangler deploy`. No CORS in the default setup.
- Hono for routing. All routes built with `@hono/zod-openapi` — each endpoint's
  zod schema does triple duty: runtime validation, OpenAPI spec, inferred types
  for the RPC client. ONE route tree (no separate "RPC for us / OpenAPI for
  others"). Serve interactive docs with Scalar at `/api/docs`.
- Drizzle ORM + D1 (SQLite). Migrations via drizzle-kit generate →
  `wrangler d1 migrations apply`. Set `migrations_dir` in wrangler config.
- R2 for files (baby photos, backup exports). Never a public bucket — stream
  through an authed Hono route (`/api/files/:id`).
- KV for rate-limiting counters and any session-cache secondary storage.
- Cron Triggers for scheduled work (reminders, nightly D1 export to R2).
- Compatibility date ≥ 2026-08-04 (Node.js compat incl. node:crypto is default;
  the `web-push` npm package is expected to work — verify early, fall back to a
  WebCrypto-based implementation if it trips).

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
- **Cloudflare Workers gotcha:** D1 bindings only exist inside the request
  handler. Create the better-auth instance per-request via a factory, stash it
  on Hono context in middleware. Never initialize at module scope.
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

## D1 constraints (respect these)

- No transactions — only `batch()`. Multi-row atomic writes (e.g. redeem invite:
  validate + increment + addMember) must be structured as batches; design so
  partial failure is safe.
- Backups: scheduled Cron export to R2 (no "copy the .db file" story).
- D1 is regional; fine for this app, don't chase edge-read tricks.

## Phased roadmap

> **Status (2026-08-24): Phases 1–4 SHIPPED** to https://app.pjokk.no
> (custom domain; workers.dev fallback stays enabled; Refsdal Holding AS
> account). Phase 2 delivered the day-grouped timeline (merged
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
> IconNote deliberately).
> Also already in place ahead of schedule: night mode (scheduled + manual),
> minimal Settings (members, invite link w/ QR + revoke, night mode, sign
> out), PWA update toast, offline persist + paused-mutation queue.
> Deviations & boring choices are logged in DECISIONS.md — notably:
> passkey plugin is server-side only (no UI yet), email/password sign-IN is
> enabled as the dev/demo path (signup stays closed), log sheets omit the
> notes field until the edit sheet lands in Phase 2, and Google OAuth
> credentials are still placeholders (see SMOKE-TEST.md for go-live steps).

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
- Tests: colocate; prioritize the tenancy middleware, invite redeem flow, and
  active-session logic. Use @cloudflare/vitest-pool-workers so tests run in the
  real runtime — and ensure wrangler config itself has the right compat date
  (the vitest plugin injects nodejs_compat, which can mask a missing flag).
- Commit style: small, scoped commits following **Conventional Commits**
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, …). Reference the
  roadmap phase in the body when the work is phase-scoped, e.g.
  `feat(timeline): day-grouped feed` with `Phase 2` noted in the body.

