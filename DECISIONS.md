# DECISIONS

Decisions made during implementation that CLAUDE.md does not cover. Boring
choices, noted so they can be revisited deliberately.

- **Work happens on `main`.** Zero-commit greenfield repo whose sole purpose is
  this build; branching would be ceremony.
- **Package manager: pnpm.** (Environment note: npm is not installed on this
  machine; pnpm is invoked via a corepack-downloaded binary.)
- **TanStack Router in code-based mode** (no file-based route generation) —
  fewer moving parts, no codegen watcher, same type safety at this scale.
- **shadcn/ui components are hand-vendored**, not pulled via the CLI registry
  (shadcn is vendored-code-by-design; the CLI is interactive and adds churn).
  Same idiom: cva + tailwind-merge + Radix where needed.

## Auth

- **better-auth 1.7 requires `account.issuer`** (unique with accountId), but
  the deprecated `better-auth generate` CLI emits a stale schema without it.
  Added by hand in `src/worker/db/auth-schema.ts` — merge, don't regenerate.
- **Email/password sign-IN is enabled** (signup stays disabled). It's the
  local-dev/demo path (seeded users) and a fallback until Google credentials
  are configured. CLAUDE.md's "email/passkey" passkey half: the server plugin
  and table are live, the UI (register/sign-in buttons) is deferred.
- **`OPEN_SIGNUP` var (default "0")** is the founder-bootstrap escape hatch:
  social sign-in refuses new users unless they come through /join/CODE
  (`requestSignUp`) — but the very first account has no invite. Set to "1",
  create the founder account, set back to "0", redeploy.
- **Closed-signup enforcement is client-flow-shaped**: a determined caller
  could POST the social sign-in endpoint with `requestSignUp` themselves
  without a valid invite; they'd land in an account with no family and no
  data access. Acceptable for alpha; tighten with a signup hook later.
- The public `GET /api/invites/info/:code` reveals the family name to anyone
  holding a code. Codes are credentials (72 h, rate-limited) — accepted.

## Product scope (Phase 1)

- **Home shows the first baby** (families here have one). The switcher joins
  the caretaker-chip menu later.
- **Log sheets omit the notes field** — five-second flow wins; notes arrive
  with the edit sheet (Phase 2, same component).
- Sleep locations are a fixed chip set (crib/stroller/arms).
- Night mode state lives in localStorage per device (a nursery tablet and a
  phone legitimately differ); org-level schedule config comes later.
- Invite defaults: role member, 72 h, max 5 uses.

## Phase 2

- **Timeline is a server-merged endpoint** (`GET /api/timeline`): three
  scoped queries (each over-fetching one page) merged and cut in the Worker,
  with an ISO `before` cursor. Day grouping happens client-side. hasMore is
  true when the merge exceeds a page OR any source filled its own quota.
- **Sleep entries sort by startTime** in the timeline.
- **Update payloads use null-to-clear semantics** (omitted = untouched,
  null = cleared) so type switches can drop stale fields.
- **Editing an active sleep session never touches its endTime** — ending a
  session is exclusively the Wake action.
- **Dark mode is device-local** (system/light/dark in Settings) and layered
  under night mode: `.night` is declared after `.dark` in CSS, so night wins
  while both classes are set.
- **Local D1 state is keyed by `database_id`** — changing the id in
  wrangler.jsonc silently starts an empty local DB. Re-run
  `pnpm db:migrate:local && pnpm seed:local` after any id change.

## Phase 3

- **The six activity types are ONE pattern, instantiated:** a generic
  `logCrud` (scoped.ts) + `makeLogRoutes` factory (other-logs.ts) + one
  `OtherLogSheet` dispatcher component. Route *definitions* stay concretely
  typed per instantiation (exact OpenAPI + RPC types); the factory's four
  handler bodies use contained casts because zod-openapi's input inference
  cannot follow type parameters. Runtime validation is unaffected.
- **API paths:** /api/medicine, /api/baths, /api/notes, /api/milestones,
  /api/measurements, /api/pumps.
- **Measurement units are implied by type:** weight in kg, length/head in cm
  (REAL values; steppers use 0.1 kg / 0.5 cm).
- **Timeline `filter=other`** groups all six; the filter chip row is
  All/Feeds/Sleep/Diapers/Other.
- **Prefill for the new sheets reads the cached list only** (a cold first
  open shows defaults; every later open prefills). Chosen over async prefill
  plumbing.
- Pump logs are tied to the baby (same scoping as everything else), even
  though pumping is about the parent.

## Phase 4

- **Stats day-bucketing happens server-side in the caretaker's timezone**:
  the client sends `Date.getTimezoneOffset()` and `/api/stats` splits sleep
  sessions across local midnights (active sessions count up to now). DST
  transitions can shift a bucket edge by an hour — accepted.
- **Averages divide by the full window** (7/30 days) including today's
  partial day. Simple and predictable over clever.
- **The weight row shows a trend (Δ vs previous weight), not a percentile.**
  Percentiles need the baby's sex (no such column yet) + WHO LMS reference
  data — both land with the Phase 7 growth curves.
- **Recharts is lazy-loaded** with the Stats route (its ~350 kB chunk would
  otherwise grow the main bundle by 70%).
- **CSV export is one file for the whole family** (all babies, all kinds,
  chronological, `kind` column + union of detail columns), served as a plain
  non-OpenAPI route with content-disposition. Any member can export.

## Phase 5

- **web-push works under nodejs_compat** (verified per CLAUDE.md before
  building): we use `generateRequestDetails` for the aes128gcm/VAPID crypto
  but do the HTTP ourselves, so 404/410 responses prune dead subscriptions.
- **VAPID subject falls back to https://app.pjokk.no** when APP_URL is http
  (local dev) — the spec requires https: or mailto:.
- **Reminders are one-nudge-per-gap**: `lastRemindedAt >= lastFeed` gates
  re-sending; a new feed starts a new observation window, and changing the
  pref resets it. Cron runs every 15 min, so delivery lags the threshold by
  up to 15 min.
- **Reminder scope is the family's most recent feed** (any baby) — right for
  one-baby families; revisit per-baby when a family actually has two.
- **Backups are JSON row dumps to R2** (`backups/YYYY-MM-DD.json`, all
  tables incl. auth). D1 has no in-Worker dump API; restore is manual by
  design. Old backups are kept (R2 lifecycle rule later if it ever matters).
- **Push handlers ship via `workbox.importScripts`** (public/push-sw.js) —
  no injectManifest migration needed.
- **vitest-pool-workers 0.22 removed `fetchMock`**; outbound push HTTP is
  tested by stubbing global fetch (tests share the worker isolate, so the
  stub applies to worker code too).

## Infra

- **Deployed to the Refsdal Holding AS Cloudflare account**
  (`ec92f89b...`, chosen because the repo lives under ~/projects/refsdal and
  pjokk.no is personal). To move: create D1/KV/R2 in the new account, update
  ids in wrangler.jsonc, re-apply migrations, re-set secrets, redeploy.
- **Deploy command is `wrangler deploy -c dist/pjokk/wrangler.json`** — the
  Cloudflare Vite plugin emits the deployable config into dist. `pnpm deploy`
  wraps it.
- `workbox-window` is a direct dependency (pnpm doesn't hoist it for
  vite-plugin-pwa's virtual register module).
- vitest-pool-workers 0.22 dropped `defineWorkersConfig`; tests use the
  `cloudflareTest()` Vite plugin API with explicit miniflare bindings (no
  wrangler-config read, so the missing dist/ dir can't break tests).
