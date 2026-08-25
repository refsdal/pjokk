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

## Phase 6

- **Icons are exclusively @tabler/icons-react** (lucide-react removed).
  Pairings from the icon review: Feed=IconBabyBottle, Diaper=IconDiaper,
  Pump=IconMilk, Sleep=IconMoon, Medicine=IconPill, Bath=IconBath,
  Milestone=IconSparkles, Measurement=IconRuler, Note=IconNote.
- **The "has a note" row indicator and the Note activity share IconNote** —
  both mean "there's note text here"; one glyph, one meaning.
- Tabler's stroke-width prop is `stroke` (not `strokeWidth`); components
  type icons as `Icon` from the package (function components, not
  ForwardRef like lucide).

## Phase 7 (growth, Norwegian, API keys)

- **WHO LMS data is real, sourced data** (never from model memory): the
  weight-for-age tables came from GlobalStrategies/jsgrowup (repackaged WHO
  igrowup tables; anchors verified against published medians, e.g. boys
  birth M=3.3464). Bundled as a 3.2 kB JSON; percentile math is client-side
  (LMS → z → Φ(z), Abramowitz–Stegun erf).
- **baby.sex is nullable** ("girl"/"boy"); percentiles and the growth chart
  simply don't render until it's set (Settings → Babies → tap → Edit).
- **Language is device-local** (auto → nb for nb/nn/no devices, else en;
  manual override in Settings). t() reads a module-level dictionary keyed by
  the English source string; a state bump in AppearanceProvider re-renders
  the tree on change. Dynamic keys (e.g. "Edit "+label) resolve because the
  keys are built from English constants.
- **API keys are read+write** (user's choice — enables HA automations that
  log): they authenticate as the creating caretaker (attribution), are
  SHA-256-stored/shown once (pjk_ prefix kept for the list UI), refuse
  admin + push endpoints, and track lastUsedAt coarsely (≥5 min apart).

## Phase 8 (system admin)

- **System admin = better-auth admin plugin** (user.role "admin"), fully
  separate from per-family member roles. Bootstrap is a manual SQL UPDATE
  (dev seed makes Anders admin; prod granted to andersro93@ros-nett.com).
- **/admin is a lazy route**, English-only operator console, hidden behind a
  Settings link + role guard client-side and requireSysadmin server-side.
- **User support ops go through better-auth's /api/auth/admin/*** (list,
  ban, revoke sessions, set password, impersonate, remove); custom
  /api/admin/* covers what that plugin can't know: families, stats, audit.
- **Audit trail**: server-side writes for our endpoints (family.delete);
  better-auth admin ops are client-noted via POST /api/admin/audit —
  sysadmins are trusted, the trail is for recall, not defense.
- **Impersonation** shows a red in-app banner (session.impersonatedBy) with
  a Stop button; every use is audited.
- API keys can never be system admins (rejected before the role check).

## Security review (2026-08-24)

High/medium findings were fixed the same day; low findings are tracked as
GitHub issues #1–#7.

- **H1**: KV rate limit (20/10 min/IP) fronts /api/auth/sign-in/email —
  better-auth's built-in limiter is memory-backed and useless on Workers.
- **H2**: family creation is sysadmin-only
  (`allowUserToCreateOrganization`); everyone else joins via invite codes.
  Accounts that bypass signup are inert and swept by a daily orphan purge
  (7 days old, no membership, not admin; FK-protected users skipped). The
  Welcome screen tells non-admins to use an invite link. New legitimate
  families are created by the operator.
- **M1**: CSV export neutralizes formula prefixes (=+-@, tab, CR) with a
  leading apostrophe.
- **M2**: push subscribe only accepts https endpoints on known push-service
  hosts (FCM/APNs/Mozilla/WNS) — the worker never POSTs to arbitrary URLs.
- **M3**: security headers everywhere — public/_headers for assets (CSP,
  frame-ancestors none, HSTS, nosniff, referrer, permissions-policy) and a
  worker middleware for /api/* (no CSP there; /api/docs loads Scalar's CDN
  bundle).
- **M4**: API keys support expiry (default UI choice 1 year; never possible)
  and a read-only flag (GET/HEAD only). Enforced in apiKeyAuth.
- **M5**: user deletion goes through POST /api/admin/users/:id/delete —
  reassigns all non-cascading FKs (log attribution, invites, keys, audit) to
  the banned "Deleted user" tombstone, audits, then deletes. Client no
  longer calls better-auth removeUser (FKs would 500 it).

## Quality reviews (2026-08-25)

Architecture + line-by-line + UX reviews; batches 1–5 implemented same day.

- **Defects fixed** (batch 1): orphan purge role filter (better-auth stamps
  role="user" — test helpers now mirror that), empty-PATCH 500s, DB-enforced
  single active sleep (partial unique index + 409 on the UNIQUE cause
  chain), lossless timeline keyset cursor ("ms|id", global time-DESC/id-DESC
  order), backup covers api_key/admin_audit, case-insensitive invite codes,
  formatRelative across midnight, measurement type-switch reseeds value,
  local-time date inputs, night-flip never unmounts an open sheet, More
  picker prefetches prefill lists.
- **Guardrails** (batch 2): GitHub Actions CI (lint+types+tests+build),
  Biome as linter/formatter (pnpm check runs it), Settings + data-layer god
  files split by domain (public import surfaces unchanged), isSysadmin()
  as the single session-role cast.
- **Failure paths** (batch 3): optimistic summary updates (offline glance
  correct immediately; rollback + toast on error), ALL mutation error
  toasts live in the mutation defaults (covers offline-resumed mutations),
  shared Loading/ErrorState on Home/Timeline/Stats/Join, Welcome trap has
  Sign out, --color-on-accent kills white light in night mode.
- **a11y + i18n** (batch 4): pinch-zoom restored, aria-live toasts, one
  ChipGroup (aria-pressed, 44px) for every chip row, real buttons,
  aria-current tabs, live stepper values, reduced-motion support;
  time.ts relative/age strings localized.
- **i18n guard** (batch 5): scripts/check-i18n.mjs fails CI when a t()
  literal lacks a dictionary entry (caught "Admin console" on first run).
  Tombstone moved to the db layer; test scrypt hash memoized.
- **Deliberate non-goals:** no monorepo, no repository-pattern over
  drizzle, no DI, code-based routing stays, blunt cache invalidation stays.
- **Still on the backlog** (tracked, not urgent): migrate feeds/diapers
  routes onto makeLogRoutes, scoped.ts directory split, core-three
  categoryMeta dedup, sheet-lifecycle hook extraction, back-gesture closes
  sheets, family switcher / multi-baby picker, install-to-home-screen hint,
  pre-paint theme script, sentence-splice translation keys.

## Multi-baby & member management (2026-08-25)

- **Baby selection is a device-local external store** (localStorage +
  useSyncExternalStore) so Home/Timeline/Stats share one selection without a
  provider; falls back to the first baby, self-heals if the selected baby is
  gone. The baby's name IS the switcher (chevron appears with >1 baby);
  Timeline/Stats carry a compact corner chip.
- **One BabySheet for add + edit + delete** (delete is family-admin only,
  cascades every log, warned + two-tap).
- **Member management rides on better-auth's org API** (updateMemberRole /
  removeMember — server-enforced permissions); the client additionally
  refuses to demote/remove the LAST admin, and admins can't manage
  themselves from the sheet. Removed members keep their attribution on old
  entries; their stale session dies at requireFamily (tested).
- MemberSchema now exposes the member-row id better-auth addresses.
- Low-severity security issues #1–#7 all fixed and closed (global invite
  rate backstop, session-gated docs, seed prod interlock, redacted +
  30-day-expiring backups, no XFF fallback, server-side admin-op audit,
  impersonated-write audit).

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
