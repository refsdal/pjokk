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

## Phase 9 (Stripe billing)

- **@better-auth/stripe with org-level subscriptions AND org-level customers**
  (`organization: { enabled: true }`, `subscription.enabled: true` scoped by
  `referenceId` = family id): the family owns both entitlement and the Stripe
  customer, so any family admin (or org owner) can manage billing —
  `authorizeReference` checks the caller's member role is admin/owner before
  letting them buy/cancel/restore/list.
- **`organization.plan` values `free|premium|lifetime|comp`.** Webhooks only
  ever move free↔premium (`onSubscriptionComplete/Update/Cancel/Deleted` →
  `applySubscriptionStatus`); lifetime is granted exclusively by `onEvent`
  reacting to a `checkout.session.completed` with `mode: "payment"` and
  `metadata.kind === "lifetime"`; comp is an audited sysadmin override whose
  zod schema accepts only `free | comp` by hand — Stripe-derived values
  (premium/lifetime) can never be hand-set, only written by webhooks.
- **Soft-lock downgrade**: API keys persist across a downgrade but stop
  authenticating (402 `PLAN_REQUIRED`) rather than being revoked — the
  soft-lock is symmetric with the growth-chart/CSV/stats gates and reversible
  the instant the family re-subscribes.
- Price IDs (`STRIPE_PRICE_PREMIUM_MONTHLY/YEARLY`, `STRIPE_PRICE_PREMIUM_LIFETIME`)
  are env secrets, NOK-only, tax handled by Stripe Tax with inclusive prices
  (`automatic_tax: { enabled: true }` in `getCheckoutSessionParams`);
  displayed prices (20 kr/mo · 200 kr/yr · 400 kr lifetime) are hardcoded
  i18n strings, not read back from Stripe.
- No trial — everyone, including existing alpha families, starts `free`.
  `onSubscriptionComplete` hardcodes `"active"` rather than reading
  `subscription.status`; harmless while no `freeTrial` config exists on the
  plan, but would need revisiting if a trial is ever added (a trialing sub
  would be misreported as active).
- **Webhook signature verification confirmed working under nodejs_compat** —
  the plugin's async WebCrypto path (`constructEventAsync`) returns 400 for
  unsigned/forged payloads out of the box; no WebCrypto fallback was needed
  (contrast Phase 5's web-push, which did need one). Installed `stripe@22.5.0`
  + `@better-auth/stripe@1.7.1`; Stripe API version pinned to
  `2026-07-29.dahlia` — the design spec said `2026-06-24`, but the installed
  SDK's types forced the newer pin.
- All plugin option/hook names matched the upstream docs as designed —
  `onSubscriptionComplete/Update/Cancel/Deleted`, `annualDiscountPriceId`,
  `authorizeReference`, `onEvent`, `getCheckoutSessionParams`,
  `organization.enabled` — no naming surprises during implementation.
- **Lifetime checkout uses `customer: <org stripeCustomerId>`** when the
  family already has a Stripe customer (created by an earlier subscription
  checkout), falling back to `customer_email` otherwise — so a lifetime buy
  reuses the existing customer instead of creating a duplicate. Implemented
  as a narrow `fam.stripeCustomerId()` scoped-query helper
  (`src/worker/db/scoped.ts`), NOT by widening the existing `fam.family()`
  helper: that was tried first and reverted because it leaked
  `stripeCustomerId` through `GET /api/family` to every member; a regression
  test now pins the field's absence from that response.
- **Stats month gate runs before the unknown-baby 404 check** (`GET
  /api/stats`): a free family probing `days=30` with a foreign `babyId` gets
  402 `PLAN_REQUIRED`, not a distinguishing 404 — avoids letting an
  unauthenticated-for-that-baby caller learn baby-existence via gate-order
  side channel.
- **`requireFamily` now inner-joins `organization`** to load `plan` in the
  same read as the membership check (previously a separate query per
  request). Side effect: a member row belonging to a hard-deleted
  organization (orphaned FK) now fails the join and 403s instead of
  authenticating with an undefined plan — an existing edge case made stricter
  as a byproduct, not a regression.
- **Admin plan override** (`POST /api/admin/families/:id/plan`) accepts only
  `free | comp` (zod enum, mirrors the webhook-only rule above); the
  Settings/admin UI additionally hides the override control once a family is
  already on a paying plan, but the endpoint itself still permits overriding
  a premium/lifetime family — a deliberate support escape hatch (e.g. comp'ing
  a family mid-dispute), audited as `billing.plan.set`.
- Admin billing tools (revenue/subscription visibility beyond plan override)
  and coupon support remain a post-Phase-9 backlog item.
- **`past_due` downgrades immediately** (excluded from `PREMIUM_STATUSES`):
  deliberate — matches the spec's chosen "soft lock, keep data" option over a
  grace period; recovery events (`active`/`trialing` again) restore premium
  automatically. The plugin's webhook hooks also swallow errors internally
  (Stripe always gets a 200, regardless of whether `applySubscriptionStatus`'s
  D1 write succeeded), which is why the nightly `reconcilePlans` cron step
  exists — a paying family stuck on `free` by a failed write self-heals by
  03:15 UTC the next day rather than staying stuck until the next webhook.
- **Edge race accepted**: a lifetime payment completing after a sysadmin comp
  is dropped by `grantLifetime`'s guard (only `free`/`premium` are
  upgradeable to lifetime) — vanishingly unlikely (comp and a concurrent
  Stripe checkout on the same family), and support resolves it via the
  audited override rather than adding contention-handling for a case this
  rare.

## Entitlement rework (2026-08-25)

- **Free-tier re-split** (Phase 9 superseded): 1 baby max, feed/diaper/sleep +
  **medicine** logging, timeline, day + week stats, reminders, night mode, PWA.
  Premium: additional babies (`multipleBabies` feature), five other activity
  types (`otherActivities`: bath/note/milestone/measurement/pump), growth
  charts, month stats, CSV export, API keys.
- **Medicine stays free** — safety-adjacent (dose tracking across tired
  caregivers); the one gate that would feel hostile; `canUse` never gates it.
- **Soft-lock, keep data** (consistent with Phase 9): existing entries of
  gated types (other activities, additional babies' data) remain visible in
  timeline and can be edited/deleted; only CREATION is premium. Baby limit
  gates adding a baby (`POST /api/babies` returns 402 on `≥1 existing + free`),
  never deleting or editing existing babies — a free family with 2 babies
  before this ships keeps both forever.
- **Grayed, not hidden**: the More sheet shows all six activity tiles; locked
  ones render muted with a lock badge and tapping opens the upgrade prompt
  (Settings → Billing). "Add baby" row in Settings gets the same treatment
  (lock badge, disabled state, link to Billing). Server gates (402
  `PLAN_REQUIRED`) back every client gate.
- **Feature type expanded** (`src/worker/entitlements.ts`): `type Feature =
  "otherActivities" | "multipleBabies" | "growthCharts" | "apiKeys" |
  "csvExport" | "statsMonth"`. All plan reads go through `canUse(family,
  feature)`, unchanged API.
- An offline-queued create of a gated kind (e.g. a second baby, or a bath/note
  logged while offline) that replays after the family has downgraded is
  rejected with 402 `PLAN_REQUIRED` and dropped with a toast rather than
  retried or silently kept queued — accepted under the same soft-lock
  semantics as the online gate.

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
- **Test environment = a Wrangler environment, not a separate repo/config**
  (`env.test` in wrangler.jsonc → worker `pjokk-test` at app-test.pjokk.no).
  An environment IS a standalone worker at runtime — own D1 (`pjokk-test`),
  KV, R2 (`pjokk-test-files`), secrets, crons, custom domain — but managed
  from the one config file so code and infra can't drift. Rejected: a
  duplicated wrangler config (drift risk) and git-integration preview URLs
  (no clean stateful isolation; auth redirect URIs and Stripe webhooks need
  a stable origin). The Vite plugin selects the env via `CLOUDFLARE_ENV=test`
  at build time; the emitted dist config is already fully resolved, so the
  deploy command takes NO `--env` flag (passing it double-suffixes the name
  to `pjokk-test-test` — learned the hard way, worker deleted).
  `--env test` IS still used for wrangler commands that read the source
  config: `secret put`, `d1 migrations apply`, `d1 execute`.
- **Test env is the permanent home of Stripe test mode**: sk_test key,
  test-mode price ids and a test-mode webhook endpoint point at
  app-test.pjokk.no; production only ever holds live keys. Google/Stripe
  test-env secrets are placeholders ("unset") until filled per
  SMOKE-TEST.md §7.
- **CI deploys test on every green push to main** (deploy-test job in
  ci.yml, gated on the `CLOUDFLARE_API_TOKEN` repo secret — skips
  gracefully while unset). Production deploys stay manual (`pnpm deploy`).
  No Cloudflare Access in front of app-test: closed signup is the gate,
  same security model as production. `workers_dev` is off for the test env
  (that origin isn't in better-auth's trusted origins).
- **Self-serve family creation** (post-Phase 9): any signed-in account with
  NO existing membership may create a family (sysadmins always can); members
  of a family cannot create a second one. This deliberately retires the
  sec-review-H2 posture that "a signup-bypass account can't do anything" —
  the gate moves entirely to ACCOUNT creation (OPEN_SIGNUP / invite links).
  The Welcome invite-only wall is gone; family-less users get the create
  flow (family → baby → plan) with an "Invited to a family?" pointer and
  sign-out escape below the form.

## Feedback batch (2026-08-25)

- **Night mode's "On" chip is the manual override, not a schedule toggle**:
  at 20:54 the schedule wasn't active yet, so the tester's "On" tap was
  read as "force on regardless of schedule" — that behavior was already
  correct, only the label was misleading. Fixed the label; the
  schedule-vs-override logic itself is untouched, and the override remains
  device-local (localStorage), same as the rest of night mode.
- **Solids are still stored in `amountMl`** — grams are written into the
  same column, with the unit derived from the feed's `type` (`solids` →
  grams, `bottle`/`breast` → ml) everywhere the value is read or
  displayed. Avoided an `amountG` column/migration for a unit that's
  cosmetic at the storage layer. Intake sums (stats, home status card,
  CSV) count **bottle-only** ml, so solids grams never get added into a
  ml total.
- **Custom sleep locations are stored by name in `sleep_log.location`**,
  the same free-text column defaults (Crib, Arms/Contact nap, Car, …)
  already used. Defaults and family-defined customs are merged
  client-side into one chip list; there's no `sleep_location` foreign key
  on the log row. The `asLocation` coercion (that clamped free text back
  onto the default enum) was removed since customs are now first-class.
- **Per-side nursing minutes live in new nullable columns** on
  `feed_log` (left/right minutes), additive to the existing
  `durationMin`, which stays the total and is what CSV export reports —
  CSV does not break out per-side minutes.
- **Home's sleep sub-line renders the app-wide `formatDuration` "h:mm
  today" format** (e.g. "2:10 today"), a deliberate deviation from the
  spec's "2 h 10 m" wording — consistency with every other duration on
  the app (active sleep banner, timeline spans) won out over matching the
  spec's prose exactly.
- **Toolchain pinned with mise** (`.mise.toml`: node 22, pnpm 11) — replaces
  reliance on corepack, whose shim broke locally (ERR_VM_DYNAMIC_IMPORT_
  CALLBACK_MISSING under node 22.22 + corepack pnpm 11.23). `mise install`
  in the repo is the whole setup; CI keeps its own version pins in ci.yml.
  Considered and rejected: switching the package manager to Bun — installs
  are already fast, and @cloudflare/vitest-pool-workers requires vitest
  under Node, so the risk sits exactly where this project is unusual.

## Calendar (2026-08-25)

- Bespoke module (sleep-locations pattern), NOT logCrud: events have no
  required baby, a start+duration shape, and two join tables
  (calendar_event_baby, calendar_assignee) the factory can't express.
- Single range endpoint (GET /api/calendar/events?from=&to=), no cursor
  pagination — family calendars are dozens of rows; range capped at 366 days.
- Free tier sees the full calendar UI with a locked Add button and an upsell
  empty state (not a hard upsell page): keeps the soft-lock promise that
  downgraded families can still see and edit existing events.
- Calendar mutations skip the offline paused-mutation queue: planning is a
  deliberate online act, unlike 3am logging.
- Reminders: one lead time per event (60/1440 min chips), targeted at
  assignees when set, else all members; latched via remindedAt; events >60 min
  past are latched silently (no late reminders after downtime); editing
  startTime or the lead re-arms the latch.
- v1 exclusions (spec'd): recurrence, multi-day events, ICS, timeline
  integration.
- Note (review): reminders may fire up to 60 min after start (cron-tick
  tolerance inside the grace window) — spec-intended.
- Reminders keep firing for downgraded (free) families' existing events —
  consistent with the soft-lock rule (existing data stays fully functional).

## Contacts, play, vaccines (2026-08-27)

- **Contacts are a bespoke module, not logCrud** — the first domain entity
  with no `time` and no caretaker attribution. Baby links reuse the
  calendar's convention: zero `contact_baby` rows = the whole family owns
  the contact (the shared doctor), some rows = scoped (grandma for one
  sibling). `role` is free text on purpose; an enum would never survive a
  real family. `icon` is a fixed key set so it stays a Tabler glyph rather
  than arbitrary emoji.
- **Contacts live in Settings → Family** (inline section, like Babies), not
  a sixth tab and not a sub-route — Settings has no sub-screens anywhere
  else, and a phone list is reference data, not a daily glance.
- **Play timers are a database row, not a Durable Object.** `play_log`
  mirrors `sleep_log`: `end_time IS NULL` means running, a partial unique
  index (`play_one_active_per_baby`) makes double-start impossible, and the
  client computes elapsed from `start_time`. A DO would add a stateful
  class and a second source of truth to buy nothing the row shape doesn't
  already give; it would only start earning its keep for push-based
  realtime or per-activity alarms, and the */15 cron covers nudges.
- **activePlay rides on /api/summary**, not its own query — the home screen
  already makes that call, so the banner costs no extra round trip.
- **A running play session may coexist with a running sleep session.** They
  are independent one-per-baby slots; policing the combination would be
  guessing at the family's intent.
- **Play collapses sprout's five PlayTypes into three** (tummy, walk, play)
  with the original kept in notes — two types would have silently dropped
  INDOOR_PLAY/OUTDOOR_PLAY/CUSTOM rows on import.
- **Vaccine log free, documents premium.** The record is health data and
  gating it would be indefensible; only the files cost storage. Same
  soft-lock rule as everywhere else: upload 402s, read and delete never do.
- **The Norwegian programme is a reference overlay, never a constraint.**
  Bundled static JSON (the WHO-LMS pattern), matched to logged doses by
  explicit `scheduleSlot` or by name + dose number, so imported and
  hand-typed records still land in the right row. Anything unmatched shows
  under "Other vaccines" rather than disappearing. The schedule is FHI's
  published programme and should be re-checked against fhi.no before
  anyone relies on it; ages are nominal, and the helsestasjon decides.
  A per-country programme is a later data change, not a redesign.
- **Vaccines are a screen (/vaccines), not a sheet** — a 14-row schedule
  needs more room than the More tray.
- **First real R2 path.** `/api/files/:id` was specified in CLAUDE.md from
  the start but only built now. Object keys are server-generated (a client
  filename never reaches the store), types are allowlisted to images+PDF,
  10 MB cap, 5 per entry, and everything is served
  `Content-Disposition: attachment` + `nosniff` so an uploaded file can
  never execute in the app's origin. Images are downscaled to 1600px in the
  browser before upload. No per-family quota: invite-only signup is the
  real limit, and quota accounting can be added without a redesign.
- **Deleting a vaccine deletes its R2 objects**, after the row is gone — a
  failure there leaks an orphan object rather than leaving a document row
  pointing at nothing.
- **Migrations are hand-written from 0007 on.** `drizzle-kit generate`
  diffs against `meta/0006_snapshot.json`, which predates billing, feedback
  and calendar, so it emits CREATE TABLE for tables that already exist and
  collides on the file number. Write the SQL by hand and match the existing
  style; `wrangler d1 migrations apply` orders by filename and ignores
  drizzle's journal entirely.

## GDPR hardening (2026-08-27)

The app stores Article 9 special-category health data — vaccines, medicine,
measurements, and arguably an infant's whole feed/sleep record. That has
been true since Phase 3; the vaccine feature only made it obvious.

- **CSV export is free on every plan.** `csvExport` stays in the Feature
  union with `requiresPremium: false` rather than being deleted, so the
  decision reads as deliberate. Access (Art. 15) and portability (Art. 20)
  must be provided free of charge; paywalling a family's own data is not
  defensible. Stats beyond 7 days remain premium — that is analysis we
  built, not the underlying data, and the export returns everything.
- **Backups expire after 30 days** (`BACKUP_RETENTION_DAYS`), pruned by the
  nightly cron. Unbounded snapshots both breached storage limitation and
  quietly defeated erasure: a deleted family lived on in every older
  snapshot. 30 days is what the privacy policy commits to as the window for
  a deletion to fully take effect, so the number and the promise must move
  together.
- **Vaccine document uploads are OFF** (`DOCUMENT_UPLOADS_ENABLED = false`).
  Parents photograph the helsestasjon card, which can carry a
  fødselsnummer — Norwegian law treats that specially, and it is not worth
  taking on before the privacy work around it is reviewed. Reading and
  deleting stay open so anything already stored can still be retrieved and
  erased; disabling a feature must never strand data. The tables, routes
  and tests remain so re-enabling is one constant.
- **Logs carry ids, never emails.** Workers logs sit outside our retention
  control, so an address written there is personal data we cannot later
  erase.
- **/privacy and /terms are public routes**, readable without an account: a
  prospective member deciding whether to accept an invite, and a supervisory
  authority, both need them. Linked from Settings, the login screen, and —
  most importantly — the invite screen, which is the actual moment of
  consent. Written as prose rather than through `t()`: a policy split across
  hundreds of dictionary keys would rot. A Norwegian version is outstanding
  and matters legally for Norwegian users.
