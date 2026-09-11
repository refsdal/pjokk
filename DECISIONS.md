# DECISIONS

Decisions made during implementation that CLAUDE.md does not cover. Boring
choices, noted so they can be revisited deliberately.

- **Work happens on `main`.** Zero-commit greenfield repo whose sole purpose is
  this build; branching would be ceremony.
- **Package manager: bun** (was pnpm). Forced and then confirmed: the
  corepack-downloaded pnpm binary began crashing on every invocation
  (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` under Node 22.22.1), so no
  dependency could be added at all. Bun was already becoming the runtime, so
  one tool now covers runtime, installs and tests, and the corepack dependency
  that broke is gone. `bun.lock` is committed; images build with
  `bun install --frozen-lockfile`.
- **`stripe` is pinned to 22.5.0; everything else is unpinned again.** The
  temporary pins on hono and better-auth (added mid-port, when hono 4.13.5
  appeared to cause 31 type errors) turned out to be unnecessary: almost all of
  those errors came from `lib.ts` constraining on the ambient Cloudflare `Env`,
  which the port removed. hono 4.13.5 + better-auth 1.7.2 typecheck clean and
  pass all 200 tests. The `@better-auth/core` override went with them — it
  existed to resolve a version MISMATCH (better-auth pinned at 1.7.1 while its
  sibling adapters resolved 1.7.2), and with everything at 1.7.2 there is
  nothing to collapse.
  Stripe stays pinned because the SDK pins the Stripe **API version**: 22.6.0
  requires `2026-08-26.dahlia` instead of `2026-07-29.dahlia`. That is a
  behavioural change on the money path, and the billing tests run with fake
  keys (`sk_test_fake`), so nothing in CI can validate it. Bump it as its own
  change, together with the test-mode pass in SMOKE-TEST.md section 8.
- **TanStack Router in code-based mode** (no file-based route generation) —
  fewer moving parts, no codegen watcher, same type safety at this scale.
- **shadcn/ui components are hand-vendored**, not pulled via the CLI registry
  (shadcn is vendored-code-by-design; the CLI is interactive and adds churn).
  Same idiom: cva + tailwind-merge + Radix where needed.

## Auth

- **better-auth 1.7 requires `account.issuer`** (unique with accountId), but
  the deprecated `better-auth generate` CLI emits a stale schema without it.
  Added by hand in `src/server/db/auth-schema.ts` — merge, don't regenerate.
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
  (dev seed makes the founder admin; prod granted to the founder's account).
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
  (`src/server/db/scoped.ts`), NOT by widening the existing `fam.family()`
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
- **Feature type expanded** (`src/server/entitlements.ts`): `type Feature =
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
  (`<redacted>...`, chosen because the repo lives under ~/projects/refsdal and
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
  An environment IS a standalone worker at runtime — own D1
  (`pjokk-test-eu`), KV, R2 (`pjokk-test-files-eu`), secrets, crons, custom
  domain — but managed
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
  hundreds of dictionary keys would rot. Each page therefore carries a whole
  English body and a whole Norwegian one and picks between them, seeded from
  the app language but switchable on the page itself — these pages are
  public, so a reader may never have set a preference, and a Norwegian
  reader landing on English must be able to flip. `screens/legal/` splits
  layout from the two documents so no single file carries four bodies.
  The Norwegian is a translation of the English, not an independent text;
  both were drafted by an AI and want review by someone qualified.

## EU jurisdiction (2026-08-27)

- `wrangler d1 info pjokk` showed `running_in_region: EEUR` but
  `jurisdiction: null`. Those are different claims: the region is where the
  database happened to be placed, the jurisdiction is the only enforceable
  guarantee. A privacy policy saying "stored within the European Union"
  cannot rest on a location hint.
- Jurisdiction is settable **only at creation** — there is no `d1 update`,
  and the D1 subcommands are create/info/list/delete/execute/export/
  time-travel/migrations/insights. So the resources were recreated:
  `pjokk-eu`, `pjokk-test-eu` (D1, `--jurisdiction eu`) and
  `pjokk-files-eu`, `pjokk-test-files-eu` (R2, `-J eu`), all verified.
- Recreated rather than migrated: nothing is in production yet, so the old
  430 kB carried no value worth a data migration. The old `pjokk`,
  `pjokk-test`, `pjokk-files` and `pjokk-test-files` have since been deleted,
  so the account now holds EU-jurisdiction resources only — `r2 bucket list`
  without `-J eu` returns nothing at all. No local dump was taken on the way
  out: keeping an unencrypted copy of children's health data on a laptop
  would contradict the point of the exercise.
- Two wrangler traps met while doing it: `r2 object delete` operates on the
  LOCAL simulator unless given `--remote` (and prints "Delete complete"
  either way, including for keys that do not exist), and `r2 bucket info`
  object counts lag well behind reality — a bucket that still reported 3
  objects deleted cleanly as empty. Trust the delete, not the counter.
- R2 jurisdictions are separate namespaces: `wrangler r2 bucket list` does
  not show an EU bucket without `-J eu`, and the binding in wrangler.jsonc
  needs `"jurisdiction": "eu"` or the Worker looks in the wrong namespace.
- **KV cannot be pinned** — no jurisdiction flag exists, because KV is
  globally replicated by design. Recreating it would have achieved nothing.
  Instead the rate limiter now hashes the client IP (SHA-256, truncated)
  before using it as a key, so KV holds a pseudonymous bucket id rather than
  an address. Same brake, no personal data in a global store.
- Consequence of recreating: the new databases are EMPTY. Migrations apply on
  the next deploy (the workflow runs them first), but the founder account and
  every existing family are gone — the first account must be created again
  through the OPEN_SIGNUP=1 path documented in SMOKE-TEST.md.

## Landing page + apex domain (2026-08-27)

- **The landing page is rendered by the Worker, not the SPA.** `/` is one
  self-contained document: inline CSS, zero JavaScript, no React, no app
  bundle. A stranger reading marketing copy should not have to download the
  whole application first. The alternative — a public route inside the SPA —
  was rejected once the hero mock-up was settled as *conceptual*: with nothing
  real to reuse, staying in React bought only a blank first paint.
- **`run_worker_first` must name `/` explicitly.** With
  `run_worker_first: ["/api/*"]` the asset worker answers every non-API
  request and the Worker never sees it. This is also why the noindex
  `robots.txt` is emitted at build time by a Vite plugin and the `www` → apex
  redirect is a zone-level Rule: for every other path, there is no Worker code
  in the request path to put them in.
- **The hero mock-up is a CSS animation, deliberately not the real
  components.** Reusing `StatusCard`/`LogButton` would have dragged the app
  bundle onto the landing page; screenshots would go stale and need
  re-shooting in light and dark. The cost is a small duplicated colour-token
  block in `apps/api/src/landing/styles.ts` — keep it in step with
  `apps/frontend/src/styles.css`.
- **Language is negotiated server-side**: `?lang=` → `pjokk_lang` cookie →
  `Accept-Language` → English. Nothing flashes in the wrong language and no
  JavaScript is needed to switch. Marketing prose lives in whole per-language
  blocks (`landing/copy.ts`), not the `t()` dictionary — same call the legal
  pages made, for the same reason.
- **The session cookie is sniffed for presence, never validated.** Deciding
  between "Open app" and "Sign in" does not justify a D1 read on every page
  view; a stale cookie costs the visitor one redirect through `/login`.
  Matching must allow the `__Secure-` prefix better-auth adds over https —
  the first version did not, and a test caught it.
- **No waitlist.** Email capture was designed and dropped: a new personal-data
  store, a public write endpoint, an admin surface and a privacy-policy
  section, all for an alpha that is not accepting sign-ups. The CTA reads
  `OPEN_SIGNUP` instead, so opening signup later is an env flip.
- **Home moved from `/` to `/home`**, and the SPA has no `/` route at all.
  Links from inside the app back to the landing page must therefore be plain
  anchors, not `<Link>`. Two easy-to-miss consequences: the service worker
  needs `/^\/$/` in `navigateFallbackDenylist` (or a registered SW answers
  `/` from the precached app shell forever), and push payloads and the
  notification-click fallback must target `/home`.
- **`app.pjokk.no` is retired outright** rather than redirected. It breaks
  outstanding invite links and QR codes, which embed `APP_URL` — acceptable
  at 72 h expiry and closed-alpha scale, and it leaves exactly one origin.
  Deleting the route from `wrangler.jsonc` does NOT delete the Cloudflare
  custom domain; the DNS record and certificate survive until removed in the
  dashboard.
- **workers.dev is off in production** and `trustedOrigins` is down to
  `[APP_URL]`. A second origin that can complete a sign-in is a liability
  once a canonical apex exists.
- **`INDEXABLE` var** gates the noindex headers, `robots.txt` and
  `sitemap.xml`. Production is `"1"`; everything else is `"0"`. Chosen over
  comparing hostnames in code so the switch sits next to the domain it
  belongs to, in `wrangler.jsonc`.
- Regenerating `worker-configuration.d.ts` for the new var revealed that the
  three `STRIPE_PRICE_PREMIUM_*` types come from the local, gitignored
  `.dev.vars` — a machine without them silently loses the types and the
  typecheck fails. They are now present in `.dev.vars.example` *and* must be
  present in your `.dev.vars` before running `pnpm cf-typegen`.
- **Cloudflare's Managed robots.txt beats ours, so noindex lives in a
  header.** The zone has the managed robots.txt feature on, which PREPENDS
  its own `User-agent: * / Allow: /` group to whatever the origin serves.
  Crawlers merge groups matching the same user-agent, and for rules of equal
  path length the least restrictive wins — so the test environment's
  `Disallow: /` was being overridden and `test.pjokk.no` was crawlable.
  Found by curling the deployed test environment, not by any test.
  `X-Robots-Tag: noindex, nofollow` is the fix: it is not a file the zone
  rewrites, and it means "do not index" rather than merely "do not crawl".
  The Worker already set it on `/`; `_headers` now covers every asset path
  (`/home`, `/privacy`, `/terms`) too, which had no signal at all.
  Turning the managed feature off was the alternative, but it is zone-wide
  and its AI-crawler blocklist is worth keeping on production.
- **`_headers` is generated by the Vite plugin, not kept in `public/`.** It
  differs per environment now (only test carries the noindex line), and a
  copy in `public/` would race with the emitted one for the same output
  path. The production output is byte-identical to the file it replaced —
  worth re-checking after any edit, since this one file carries every
  security header for the SPA, `/privacy` and `/terms`.

## Docker/Postgres port (2026-08-28)

- **Docker replaces Cloudflare outright**, rather than the two being
  maintained side by side. A dual target would have meant two Drizzle schema
  files (34 tables, two dialects) kept in lockstep forever: Drizzle binds a
  schema to one dialect, and that is the one part of the stack no adapter
  layer can hide. Everything else was already adapter-shaped — all database
  access funnels through `scoped.ts`, storage was 7 call sites, KV was 2.
- **No data migration.** The port starts from an empty database; the alpha
  data was expendable. This is why `migrations/` is a single generated
  baseline rather than a hand-translated chain of the 15 SQLite migrations —
  a translated chain nobody ever ran would be fiction. The old files remain
  in git history.
- **`timestamptz`, not epoch-millisecond `bigint`.** The initial instinct was
  to keep epoch-ms to minimize churn; that reasoning was wrong. Drizzle maps
  BOTH `integer(mode: "timestamp_ms")` and `timestamp(mode: "date")` to a JS
  `Date`, so the application code is identical either way — which makes
  timestamptz simultaneously the idiomatic choice and the low-churn one. The
  entire cost was one query: the calendar reminder window.
- **Services are memoized on the Env object's identity (a `WeakMap`)**, not
  held in a mutable module-level global. Production has exactly one Env, so
  this builds one set; each test suite brings its own and gets its own, with
  no boot-order coupling and nothing to reset between runs. The consequence
  worth knowing: `Bindings` must be ONE long-lived object, so building a
  fresh `{ ...env, server }` per request would silently rebuild the
  connection pool every time.
- **`bun test` over vitest.** The suite used no vitest-specific API at all
  (zero `vi.*`), and all Cloudflare coupling sat in `helpers.ts`, so the port
  was a shim plus 10 import lines rather than 24 rewrites. Runtime went from
  81s to ~23s.
- **Tests use a real Postgres but an in-memory `Storage`.** The database is
  the thing that actually changed dialect, so faking it would defeat the
  purpose; object storage is four methods whose real behaviour was verified
  directly against MinIO while `storage.ts` was written. Requiring a running
  S3 to test the timeline would be a poor trade.
- **Test isolation is per FILE, not per test.** That matches what
  vitest-pool-workers gave each Worker, and the suites were written against
  it — they build fixtures in `beforeAll`, so truncating between tests
  deletes the rows they are about to assert on. Rate-limit counters are the
  exception and are cleared per test: they used to live in a per-Worker KV,
  and one shared table otherwise starts 429-ing partway through the suite.
- **Migrations run as a one-off, never at app startup.** Drizzle's migrator
  does not coordinate between processes, so N replicas booting together would
  race to apply the same DDL. `src/server/migrate.ts` uses drizzle-orm's
  migrator rather than the drizzle-kit CLI, so it works in a production image
  where drizzle-kit is not installed.
- **The app cannot create its own bucket.** `minio-init` does it in compose,
  and an operator does it in production. An app that can create a bucket can
  create the wrong one, in the wrong region — which for Article 9 health data
  is the failure that matters, and nobody notices until the data is already
  there.
- **`storage.put` takes `Blob | string`, never a `ReadableStream`.** Bun's S3
  client does not reject a stream: it writes the literal string
  "[object ReadableStream]" and reports success. The R2 code passed
  `file.stream()`, so accepting one would have made silent upload corruption
  both easy and invisible. A `File` is a `Blob`, so call sites lose nothing.
- **The release workflow publishes an image and stops.** Where the container
  runs is deployment infrastructure this repo does not own, so the workflow
  documents the rollout order instead of pretending to perform it.
- **Package manager is bun** — see the entry near the top; that one was forced
  by a broken corepack pnpm, not chosen.
- **The server ships BUNDLED (`bun build --target=bun`), not as source.** The
  runtime image has no `node_modules` at all: 591 MB → 165 MB. Most of the old
  weight was never needed to run anything — `@tabler/icons-react` alone was
  141 MB, and it, React, TanStack and recharts are compiled into `dist/client`
  at build time. The rest was better-auth's optional peer dependencies
  (`drizzle-kit`, `better-sqlite3`), which `bun install --production` does NOT
  drop.
  The bundle resolves everything statically except two dynamic imports:
  `async_hooks` (a Bun builtin) and `@opentelemetry/api` (optional, absent-safe).
  Source maps are kept (`--sourcemap=linked`, ~18 MB) so a production stack
  trace still points at TypeScript.
  **The risk this creates:** `bun test` runs against SOURCE, so it cannot catch
  a bundling regression. The CI image smoke test is the compensating control —
  it signs in with bad credentials and asserts 401 rather than 500 (proving
  better-auth's dynamically-resolved drizzle adapter survived bundling), checks
  the rate limiter actually wrote a row, and runs the cron entrypoint. Do not
  weaken those probes.
- **`drizzle-orm/bun-sql` is the driver, with a deliberate fallback.** It is
  the newest part of the stack; `postgres-js` and `node-postgres` have far more
  production mileage. Drizzle's `pg-core` API is driver-independent, so
  switching is a one-line change in `src/server/db/index.ts` plus the import —
  no schema, query or test changes. Kept in mind rather than pre-empted.
- **Connection pool sizing is deliberately unset.** `new SQL(url)` uses Bun's
  defaults, which is right for one container. When it becomes a problem it will
  look like `too many connections` under load or during a rolling deploy (old
  and new pods both holding pools, briefly doubling the count) — the fix then
  is a `DATABASE_POOL_MAX` env var wired into `createPool`.

## Bun workspaces move (2026-08-28)

- **Root `bunfig.toml` keeps `[install] linker = "hoisted"`.** Bun 1.4
  defaults to the isolated linker the moment a `workspaces` field exists, and
  every third-party dependency (hono, drizzle-orm, better-auth, stripe,
  web-push, react, …) is declared ONLY in the root manifest — none of the
  four packages lists them for itself. Under the isolated default, `apps/api`,
  `apps/server` and `apps/frontend` would each get a node_modules containing
  nothing but the workspace packages they depend on, and every third-party
  import would break. "hoisted" keeps the flat layout that makes the root
  manifest's dependencies visible everywhere.
- **`bunfig.toml` is resolved from the working directory only.** It does not
  merge with a parent config and does not walk up the tree looking for one —
  the file in `apps/api/` is the WHOLE config Bun sees when it runs there,
  independent of whatever the root `bunfig.toml` says. That is why the test
  preload (`test/setup.ts`) lives in `apps/api/bunfig.toml` rather than the
  root, and why the root `test` script cannot just say `bun test` — it fans
  out per package with `bun run --filter '*' test` so each package's own
  `bunfig.toml` is in effect when its tests run.
- **`bun test` from the repo root is wrong; `bun run test` is correct.** The
  root `bunfig.toml` has no `[test]` section (see above), so running `bun
  test` at the root never preloads `apps/api/test/setup.ts` and the schema is
  never applied — tests fail or pass for the wrong reasons depending on what
  state the database happened to be in already. `bun run test` invokes the
  root `test` script, which fans out to each package's own `test` script
  under its own `bunfig.toml`. Verified directly: `bun test
  ./apps/api/test/backup.test.ts` from the root gave 3 pass / 1 fail; the
  same file from inside `apps/api` gave 4 pass / 0 fail.

## Composition root (2026-08-28, PR #16)

- **No DI container.** `Deps` is a plain 12-field object, built once by
  `createDeps(env)` and passed straight into `createApi(deps)`. A container
  would buy indirection (registration, resolution, lifetime scopes) that this
  app never needs: there is exactly one composition root, exactly one
  long-lived instance of each collaborator, and no runtime configuration of
  which implementation to wire in. A plain object is also what makes the
  ports (`apps/api/src/ports.ts`) legible as a contract instead of a
  container's registration side-effects.
- **Adapters live in `apps/api`, not `apps/server`.** The obvious "ports and
  adapters" split would put the concrete Drizzle/S3/Stripe implementations in
  the composition root and only interfaces in the library. That would pull
  the Drizzle query layer out from under `bun run test`'s real-Postgres
  suite, which is exactly the coverage this codebase relies on for the
  dialect traps documented above (bigint counts, `real` precision, unique
  violation codes). Keeping `apps/api/src/infrastructure/` inside the tested
  package and exposing it only through the `@pjokk/api/infrastructure`
  package entry gets both: `apps/server` still only ever sees the `Deps`
  interface, and the adapters stay exercised by the suite that catches these
  bugs.
- **The boundary is enforced by a package entry plus a lint rule, not by
  convention.** `apps/server` cannot `import` past the `@pjokk/api/infrastructure`
  entry point even if it tried (no other subpath is exported), and a biome
  `noRestrictedImports` rule stops `apps/api`'s own routes and middleware from
  reaching into `../infrastructure` directly instead of going through `Deps`.
  Two independent mechanisms because either one alone degrades silently: a
  convention with no enforcement is a comment nobody re-reads six months
  later.
- **`AppType` is guarded by a compile-time assertion, not just inferred.**
  `createApi` must have no explicit return type annotation — an annotation
  would erase the accumulated Hono route types and silently untype the RPC
  client the frontend imports. But that failure mode is invisible to every
  runtime test: the app still boots and answers requests correctly with an
  untyped client, so nothing in `bun run test` would ever catch a regression.
  `apps/api/test/app-type.test.ts` exists purely to fail `tsc`, not to run
  anything, the one place in the suite where a compile error IS the test.
- **`git log --follow` does not connect `apps/api/src/app.ts` to its
  `index.ts` history at git's default rename-similarity threshold (50%).**
  Wrapping the whole file body in `createApi(deps) { ... }` changed enough of
  the file that git's default diff heuristic doesn't see it as a rename, so
  `--follow` dead-ends at this PR's commit. `git log --follow -M20% --
  apps/api/src/app.ts` walks back through the file's full history (verified:
  1 commit at the default threshold vs. 25 with `-M20%`, back through the
  Phase 1 route tree). Anyone doing `git blame` archaeology on the route tree
  needs the lower threshold.

## Landing split (2026-08-30, PR #17)

**Supersedes "Landing page + apex domain (2026-08-27)" above.** That entry
described the Cloudflare Worker era: the Worker rendered `/` itself, language
was negotiated per request, and `app.pjokk.no` was retired outright once the
app moved to the apex. All three are now false, in the direction this PR
moved things, not back toward the old design — kept below rather than
edited, per this file's append-only convention.

- **The apex and the app are two separate deploys again, but for a different
  reason than the pre-2026-08-27 Cloudflare split.** `pjokk.no` is a static
  site (`apps/landing`) with no server and no JavaScript, built once and
  published wherever static files are served. `app.pjokk.no` is the
  container — the SPA and the API — and `/` there IS the app now (the
  signed-in home screen is still `/home`). This is not `app.pjokk.no` being
  "un-retired" so much as the apex giving up trying to be both a container
  route and a public document at once: a static host cannot run the Worker
  code path the old design needed for `/`, so the app needed its own host
  back regardless.
- **Language is chosen at BUILD time, not negotiated per request.** With no
  server left in front of the apex, there is nothing to read a cookie or
  `Accept-Language` and decide — `apps/landing/build.ts` emits two complete
  documents per page (`/`, `/nb/`, `/privacy`, `/nb/privacy`, …), each with
  the other's `hreflang` alternate, and a crawler or a browser gets whichever
  URL it requested. The in-app Settings/Login/Join links now pick between
  them client-side using `getLanguage()` (`apps/frontend/src/lib/site.ts`),
  the same source of truth the old in-app `LegalPage` used.
- **The legal bodies are prerendered from their original React components,
  not rewritten as templates or copied by hand.** `apps/landing/src/legal/`
  holds the git-mv'd JSX (`privacy.tsx`, `terms.tsx`, the shared `H`/`List`/
  `ControllerCard` helpers, and the `UPDATED_EN`/`UPDATED_NB` constants);
  `legal.tsx`'s `renderLegalBody` calls `renderToStaticMarkup` and
  `page.ts`'s `renderLegalPage` wraps the result in the apex's own shell. A
  first pass of that shell rendered the title and body but dropped the "Last
  updated" line the old SPA shell used to show under it — the constants sat
  unreferenced and neither published document carried a date. Fixed before
  this shipped: `renderLegalPage` now renders `Last updated {UPDATED_EN}` /
  `Sist oppdatert {UPDATED_NB}` under the title, with a regression test
  (`apps/landing/test/render.test.ts`) asserting both languages contain it —
  a GDPR Article 9 privacy policy silently losing its version date is exactly
  the kind of thing that must fail a test, not a review.
- **`INDEXABLE` moved from the container's validated env (`apps/server/src/
  env.ts`) to a plain `process.env` read in `apps/landing/build.ts`.** The
  container has nothing to index any more — it is entirely behind auth — so
  its `robots.txt` and `X-Robots-Tag` are unconditional now, and `INDEXABLE`
  only controls the landing build's `noindex` meta, `robots.txt` and whether
  `sitemap.xml` is written at all. Its fail-safe direction had to be
  preserved across that move and initially wasn't: the container's schema
  defaulted unset to `"0"` (noindex), but the first landing build read
  `!== "0"` (defaulting unset to *indexable*) — inverted, so a `test.pjokk.no`
  landing deploy that forgot to set the variable would have published
  `Allow: /` and a sitemap, the exact outcome the flag exists to prevent.
  Fixed to `=== "1"` before this shipped.
- **`SITE_URL` is a real setting now, not a documented-but-unread one.** It
  was added to `apps/server/src/env.ts` when `APP_URL` and `SITE_URL` first
  diverged, but nothing read it except a startup log line — every self-hosted
  instance's Login/Settings/Join screens linked at `https://pjokk.no`
  regardless, which means every self-hoster's app would have advertised
  Refsdal Holding AS's privacy policy as its own. Fixed by exposing it to the
  SPA at build time as `__SITE_URL__` (a Vite `define`, not
  `import.meta.env.VITE_*`, since it comes from the same env var the
  container validates) and building the legal links from it plus
  `getLanguage()` in `apps/frontend/src/lib/site.ts`.
- **The service worker no longer denylists `/` from the navigate fallback.**
  That entry existed so a registered SW would not swallow the
  Worker-rendered landing page; with `/` now the app's own entry point on
  `app.pjokk.no`, denylisting it would send root navigations to the network
  and break offline use at the app's own root — the opposite of the PWA's
  stated purpose. `apps/frontend/vite.config.ts`'s `navigateFallbackDenylist`
  is down to `[/^\/api\//]`.
- **`apps/landing/dist` is not deployed by anything yet.** CI uploads it as a
  build artifact so a maintainer can grab a commit-pinned copy, but getting
  it onto the apex (and setting `SITE_URL`/`APP_URL`/`OPEN_SIGNUP`/
  `INDEXABLE` correctly for that build) is still a manual step — see
  README.md's "The landing site" section and SMOKE-TEST.md section 9.
- **The Dockerfile builds `build:client` + `build:server`, not the umbrella
  `build` script.** The umbrella script now also runs `build:landing`, and
  the container has no use for the marketing site — a landing-only render
  failure has no business failing the image build.
- The duplicated colour-token block the 2026-08-27 entry above locates at
  `apps/api/src/landing/styles.ts` moved with the rest of the landing code to
  `apps/landing/src/styles.ts`; keep it in step with
  `apps/frontend/src/styles.css` as that entry says.

## Distroless (2026-08-30, PR #18)

- **`gcr.io/distroless/base-debian12:nonroot` was chosen for attack surface,
  not size.** A spike measured both images on the same host: the previous
  Alpine image is ~118 MB real uncompressed / 47.1 MB compressed; the
  distroless single-binary image is ~113 MB / 46.8 MB. That is a small,
  incidental win, not the reason for the change. The reason is that the
  runtime image now has no shell, no package manager and no `node_modules` —
  there is nothing in it an attacker who gets code execution can use to
  install a tool, read a script, or pivot, and nothing for a scanner to flag
  as a stale package. `HEALTHCHECK` had to become a dispatcher subcommand
  (`/app/dispatch healthcheck`) for exactly this reason: there is no shell
  left to run the old `bun -e "fetch(...)"` one-liner.
- **`docker images` over-reports size on this host by roughly the size of the
  compressed image itself.** This host's containerd-snapshotter backend keeps
  both the unpacked snapshot and the compressed blob on disk and
  `docker images` sums something closer to both, so it reports each image
  here as roughly 47 MB heavier than it actually is. `docker export | wc -c`
  (or `docker save`) is ground truth — it reads the actual layer content, not
  the snapshotter's bookkeeping. Anyone comparing image sizes on a
  containerd-snapshotter host needs to use one of those, not `docker images`,
  or every comparison looks like the images grew by the same fixed offset.
- **`dispatch.ts` selects its mode with static imports, not a dynamic
  `import()` per branch.** `bun build --compile` bundles a dynamically
  imported branch as a lazily-initialised chunk, which breaks
  module-initialisation ordering inside the compiled binary: it crashed with
  "tsyringe requires a reflect polyfill" at startup. tsyringe arrives
  transitively via better-auth's passkey support through `@peculiar/x509`,
  and its decorators need `reflect-metadata` to have already run by the time
  any module that uses them is evaluated — an ordering a dynamic import does
  not guarantee inside a compiled binary. Verified during the spike; the fix
  is `import { runCron } from "./cron-cli"` etc. at the top of the file for
  all four modes, unconditionally, with the branch only choosing which
  already-initialised function to call.
- **`createDeps` is not the only place that constructs a `Deps`-adjacent
  object from scratch.** `apps/server/src/migrate.ts` calls `createDb`
  directly rather than going through `createDeps`/`createApi` — the migrator
  needs only the database, runs as a one-off outside the request path, and
  building a whole `Deps` (auth, storage, push, Stripe, …) for it would be
  dead weight in an image that has no server listening. `apps/server/src/deps.ts`'s
  docstring documents this exception inline.

## Container run modes (2026-08-31)

- **`SCHEDULER` is gone; the dispatch mode expresses it instead.** The env
  flag let two things drift out of sync with each other — a replica's mode
  (is it the one serving HTTP?) and whether it also ran the scheduler — which
  is exactly the shape of bug that ships as "every reminder fires twice"
  after someone copies an env block without noticing the flag. Modes make the
  two facts one fact: `server` mode has no code path that starts the
  scheduler at all, so a fleet of `server` replicas cannot double-fire no
  matter how the env is templated. The new modes: no argument (default;
  migrates, serves, schedules — a single container's whole job), `server`
  (serves only — what replicas run), `worker` (schedules only, plus a
  `/healthz` so its container still passes the image's HEALTHCHECK), and
  `migrate`/`migrations` (the pre-existing one-off, now an explicit alias
  pair since a typo'd extra "s" was exactly the kind of thing this
  redesign's error message already guards against for other subcommands).
- **The default mode migrates at startup, under `pg_advisory_lock`.** The
  previous rule ("migrate.ts: run as a ONE-OFF job... never at app startup")
  existed because drizzle's migrator takes no lock of its own — verified
  by reading `pg-core/dialect.js`'s `migrate()`: it reads the last-applied
  migration with a plain `session.all()` outside any transaction, then only
  wraps the actual DDL statements in one. Nothing serialises two callers
  racing that read. Wrapping the whole step in an advisory lock
  (`MIGRATION_LOCK_KEY`, a fixed int64 that must never change — renumbering
  it would silently stop two versions from contending during a rollout) makes
  the race safe instead of removing it: N containers booting at once now
  serialise on the lock, the first migrates, the rest block and then find
  nothing pending. The one part worth recording carefully: `pg_advisory_lock`
  is per-session (per physical connection), but drizzle's migrator issues
  several independent statements through `db.session`, each of which calls
  straight through to `client.unsafe(...)` — so a normal pooled client (the
  `createDb` used everywhere else, including the earlier "migrate.ts calls
  createDb directly" entry above, now superseded for this file) would be free
  to hand the lock call, the migration, and the unlock to three different
  physical connections, silently defeating the lock. `applyMigrations` uses a
  DEDICATED `new SQL(url, { max: 1 })` client for the whole step instead, so
  every borrow from the pool resolves to the same one connection. Proven in
  `apps/server/test/migrate.test.ts`, not asserted by inspection: a second
  connection holds the lock, `applyMigrations` is started against the same
  key, and the test polls `pg_stat_activity` (a backend other than the lock
  holder genuinely waiting on `pg_advisory_lock`) until it observes the
  block — ground truth from Postgres itself rather than a fixed sleep plus a
  hopeful assertion. A companion test drives a bad `DATABASE_URL` through
  `applyMigrations` and asserts it rejects, not `process.exit`s, since the
  function is now also called from the default dispatch mode, which needs to
  fall through to a clean, logged failure rather than a silent process death
  disguised as one.
- **`worker` mode answers `/healthz` for one reason: the image's own
  HEALTHCHECK doesn't know which mode it's probing.** The Dockerfile's
  `HEALTHCHECK` runs `/app/dispatch healthcheck` unconditionally against
  `PORT` regardless of what command the container was started with. A
  `worker` container that only ran the scheduler and served nothing would
  fail that probe forever and get restart-looped by whatever orchestrates
  it, despite doing its job correctly — so `worker` mode runs a minimal
  `Bun.serve` that answers `/healthz` with `{"ok":true}` and 404s everything
  else, just enough to keep the existing probe meaningful without giving
  `worker` any of the app's real routes.
- **Limen's built-in rate limiter and its session metadata both keyed on the
  raw client IP; both are now hashed.** Two places in Limen v0.2.1 record an
  address by default, and neither is obvious from the outside.
  `NewDefaultRateLimiterConfig` sets `KeyGenerator: ipExtractorFromRemoteAddr`
  and — more surprising — `opaqueSessionManager.storeSession` writes
  `{"ip_address": <raw address>, "user_agent": …}` into every session row's
  JSON `metadata` column on every sign-in. The limiter's default store is
  in-process memory (`StoreTypeCache`), so its keys never reach the database
  and the `rate_limits` table stays empty unless someone switches the store;
  the session metadata, however, is persisted, and sessions live seven days.
  Storing addresses next to Article 9 health data is exactly what the privacy
  policy promises we do not do, so `internal/auth` passes the same keyed
  extractor to both (`limen.WithSessionIPAddressExtractor`, and
  `WithHTTPRateLimiter(WithRateLimiterKeyGenerator(...))`). It is an
  **HMAC-SHA-256**, not a bare digest: the IPv4 address space is small
  enough to enumerate, so an unkeyed hash of an address is reversible with
  a rainbow table in seconds and would not be pseudonymisation at all. The
  key is derived from `AUTH_SECRET` with its own domain separator
  (`:client-ip`) so it can never be the same bytes as the signing secret,
  and it is instance-local — the right scope, since the digest only needs
  to be comparable within one deployment. Limen's limiter is
  left ENABLED rather than replaced with a no-op: it protects the auth routes
  in-process with sensible per-route rules (5 sign-ins / 10 s), our own
  `rate_limit` table covers the app's routes, and a hashed key gives up
  nothing we wanted. A test asserts the persisted metadata contains a 64-char
  digest and not the address (`TestSessionMetadataStoresNoRawAddress`) —
  the guarantee is behavioural, so it is checked behaviourally.
- **Limen's HTTP surface is an allowlist, not a denylist.** Registering the
  credential, oauth and organization plugins mounts roughly forty routes, most
  of which duplicate or contradict Pjokk's own API — Limen's invitations are
  email-addressed (wrong grain; `family_invite` is the real mechanism), its
  member and role routes apply Limen's permission model rather than ours, and
  `GET /auth/sessions` serialises a session's own token and metadata back to
  its owner. Every route left on is one we have implicitly accepted
  responsibility for, so `internal/auth` computes the disabled set as
  "everything known, minus a short allowlist": credential sign-in, Google
  authorize + callback, signout, the session read, and organization
  create/list/switch (plus signup when `OPEN_SIGNUP=1`). `knownRouteIDs` is
  hand-maintained and must be revisited on every Limen upgrade — a route added
  upstream and not listed there would be silently enabled — which is why
  `TestLimenRouteAllowlist` probes twenty concrete paths rather than asserting
  something about the list itself. That test was verified non-vacuous by
  temporarily widening the allowlist and watching all twenty become reachable.
- **A ban is enforced by revocation, not by a flag every reader must
  remember.** `users.banned` is checked in two places — `SessionFromRequest`
  (which reports a banned user as signed out, covering our own routes) and a
  guard wrapping Limen's router (which Limen never asks about, so a banned
  account could otherwise still read `/api/auth/me` or switch families with a
  pre-ban cookie). Signout stays reachable, or a banned user's browser keeps a
  cookie it cannot clear. Neither check is a substitute for revocation: the
  `Service` interface documents that whatever sets `banned` MUST also call
  `RevokeAllSessions`, because a live bearer token that merely fails two
  specific checks is one forgotten check away from working again.

## Go backend migration (2026-09-01)

- **Why Go at all.** The Bun backend worked; the reasons to leave it were
  operational rather than a defect. A single static CGO-free binary on
  `scratch` is a runtime image with no shell, no libc, no package manager and
  no `node_modules` — nothing to patch, nothing to exec into, and a
  vulnerability surface that is the binary plus one CA bundle. It
  cross-compiles, so multi-arch (amd64 + arm64) costs a link step rather than
  a QEMU build. And every asset the process needs — SPA, spec, migrations,
  tzdata — is compiled in, which is what makes `scratch` possible at all.
  Nothing about the product changed; the roadmap above is untouched.
- **The OpenAPI document flipped from output to input.** Under
  `@hono/zod-openapi` the spec was *generated* from zod schemas, which meant
  it could only ever describe what the TypeScript happened to do. It is now
  hand-written (`openapi/pjokk.yaml`) and authoritative in three directions:
  oapi-codegen generates the strict server interface from it, kin-openapi
  validates every request against it at runtime, and openapi-typescript
  generates the SPA's client types from the same file. A route that drifts
  from the contract now fails to compile or fails validation, rather than
  quietly redefining it. `internal/api/pjokk.yaml` is a committed copy that
  exists only because `go:embed` cannot reach above the module root; the
  `go generate` step copies it and a test fails if the two diverge.
- **Limen is confined to `internal/auth` behind one interface, and every
  Limen module is version-pinned.** Limen is a young library on a 0.x
  version; adopting it meant accepting that its API and its defaults will
  move. Handlers, middleware and jobs never import a Limen type — they see
  `auth.Service` (resolve session, resolve active family + role, create user,
  add member, …). If Limen stalls or breaks, the blast radius is one package
  rather than every route. The pinning is part of the same decision: an
  unpinned minor could silently add an HTTP route (see the route-allowlist
  entry above) or change a hashing parameter. Two upgrade obligations follow,
  and both are load-bearing: re-check `knownRouteIDs` against the new
  release, and re-run the auth suite, which asserts the hardening
  behaviourally rather than by inspection.
- **`pjk_` API keys stayed our own table; no auth-plugin key mechanism.** The
  design sketch assumed Limen would provide an api-key plugin the way
  better-auth did. It does not — v0.2.x publishes credential-password, oauth,
  oauth-google and organization, and nothing else — so the question answered
  itself, but the answer would have been the same anyway: `api_key` is
  family-scoped with a `read_only` flag and a displayable 12-character
  prefix, and it authorises against Pjokk's own operation tiers. A generic
  plugin would have keyed on the user, not the family, which is the wrong
  grain for a resource model where families own everything.
- **Billing is gone, not ported.** Stripe, `@better-auth/stripe`, the
  `entitlements` module, `canUse`, every 402 `PLAN_REQUIRED` gate and the
  webhook plumbing were all dropped rather than rewritten in Go. Pjokk ships
  as a container someone runs themselves; there is nobody to bill, and a
  soft-lock that can never fire is just a code path nothing tests.
  Everything that was Premium — calendar, contacts, play, API keys, CSV
  export, growth chart, stats beyond seven days, vaccine documents — is now
  simply available. `organization.plan` survives as a column (still `free`)
  so the schema does not need a migration if billing ever returns, but
  nothing reads it. Passkeys went the same way and for a weaker reason:
  better-auth's plugin was server-side only and never had UI, so deleting it
  removed nothing a user could see.
- **The cutover was a fresh database.** No data migration was written and
  none was run. The auth schema is Limen-shaped (`users`, `sessions`,
  `accounts`, `organization_members`, roles on a join row) and differs from
  the better-auth one structurally, not cosmetically; password hashes are
  argon2id where better-auth wrote scrypt. Writing a converter would have
  been a second, untested code path guarding real health data, for the
  benefit of one closed-alpha instance whose entire content is reproducible.
  Bootstrap is the documented one: `OPEN_SIGNUP=1`, create the founder
  account, set it back to `0`.
- **An `fs` storage driver, so self-hosting needs two containers instead of
  four.** The Bun app spoke only S3, which meant a self-hoster ran MinIO (and
  a MinIO init job) to store a handful of vaccine PDFs. `storage.Storage` now
  has two implementations behind the same port: `s3` for anyone who already
  has a bucket, `fs` for a mounted volume — and `fs` is the compose default.
  The image creates `/data` owned by uid 65532 at build time precisely so a
  fresh named volume inherits that ownership: a `scratch` image has no shell
  and no `chown` to fix it up at runtime. Trade recorded honestly in the
  README: under `fs` the nightly backup lands on the same volume as the
  files, which is not off-host storage.
- **The nightly backup nulls live credentials and skips `impersonation`
  entirely.** The TypeScript job only had a dev-only `account.password` to
  strip. Limen's schema carries more: OAuth access/refresh/id tokens on
  `accounts`, and — the one that matters — the literal session cookie in
  `sessions.token`. Backups are retained thirty days, so an unredacted
  snapshot would be "a valid session cookie for every user signed in that
  day", standing for a month, in object storage. Those columns are nulled; a
  session row minus its token is still useful for knowing who existed and
  when. `impersonation` is not redacted column-by-column but dropped from the
  list, because every row in it is a *pair* of live session tokens (the
  impersonated user's and the sysadmin's) and there is nothing else in the
  table worth restoring. `backup_tables_test.go` checks the list against the
  live schema in both directions, so a new table is a failing test rather
  than a silent omission.
- **Creating a family is restricted to a sysadmin or a user who belongs to no
  family.** Signup being invite-only is not on its own a closed alpha: a
  redeemed invite would otherwise let anyone mint unlimited organizations
  through the family switcher's own create route. `allowOrgCreation` is
  wired into Limen's `WithAllowOrgCreation` hook, so both entry points — our
  `CreateFamily` and Limen's `POST /organizations` — run through the same
  check and it cannot be bypassed by picking the other path. It fails
  **closed** on a query error: a user who cannot be read is neither provably
  a sysadmin nor provably family-less, and "deny" is the safe side of that.
- **`packages/shared` was demoted rather than deleted.** It was the single
  source of truth for API shapes; the spec is now. What the SPA still imports
  from it is ~40 domain types and one enum tuple, so the file stays, with
  plain `zod` instead of `@hono/zod-openapi` and its 75 `.openapi("Name")`
  tags stripped — those named schemas in a document this package no longer
  generates. It is now a partial duplicate of the generated
  `api-schema.d.ts`, which is a known and deliberate loose end: collapsing
  the two means touching ~40 SPA files and belongs in its own change.
- **`apps/frontend/src/lib/api-schema.d.ts` is excluded from biome.** It is
  openapi-typescript output. Formatting it would mean `bun run gen:client`
  produces a diff every time, which turns "is the client in sync with the
  spec?" from a byte comparison into a judgement call.
- **`scripts/seed.mjs` was deleted, not ported.** It hand-wrote rows for the
  Drizzle schema and better-auth's scrypt hashes; against the Limen schema
  it would have needed argon2id in the plugin's exact parameters (its
  verifier ignores the parameters stored in the PHC string and uses its own
  config, so a mismatch fails silently) plus the `organization_member_roles`
  join. A seed that produces an unusable password is worse than no seed. The
  documented dev bootstrap is `OPEN_SIGNUP=1`, which is also what a
  self-hoster does — so it is the path that stays exercised.

## 2026-09-01 — image build: native artifacts, COPY-only Dockerfile, distroless base

The multi-stage Dockerfile (bun stage → go stage → scratch) is gone. The SPA
and both server binaries are built natively by `scripts/build-artifacts.sh`
(`dist/server/pjokk-linux-{amd64,arm64}`, SPA embedded via go:embed before
compiling), and the Dockerfile only COPYs the binary matching `TARGETARCH`.
Multi-arch assembly went from minutes of per-platform builds to seconds of
file copying, nothing runs under QEMU, and native builds reuse the local /
CI Go and Vite caches. Cost: `docker build .` alone no longer works — the
artifact script must run first (the Dockerfile and compose say so). The base
moved from `scratch` to `gcr.io/distroless/static-debian12:nonroot`
(digest-pinned, Dependabot-bumped): same no-shell/no-libc surface, but the
CA bundle, tzdata and the 65532 `nonroot` user are maintained upstream
instead of hand-rolled. `/data` is still pre-created image-side — Docker
copies image-dir ownership onto a fresh named volume, which remains the only
root-free way to give a nonroot process a writable volume. This layout is
also exactly what GoReleaser's `dockers` block expects, if bare-binary
GitHub Releases ever become worth adopting it for. Releases are now
genuinely multi-arch (the old release workflow never passed `platforms:`
and silently published amd64-only).

## 2026-09-01 — releases: svu + GoReleaser, signed and SBOM'd

`scripts/next-version.mjs` is gone. svu (same author as GoReleaser) computes
the version from Conventional Commits — `--v0` reproduces the old
breaking-bumps-minor-while-major-is-0 rule, and the release workflow's
`allow_major` input drops it. GoReleaser owns everything downstream of the
tag: binary archives + checksums + SPDX SBOMs on a GitHub Release with a
generated changelog, the multi-arch image via the same COPY-only Dockerfile
(`dockers_v2`, BINARY_ROOT build arg), and keyless cosign signatures on the
checksum file and the pushed manifests (GitHub OIDC — no keys to hold). The
tag now comes BEFORE the publish (GoReleaser releases from a tag); a failed
publish deletes it, preserving the old never-a-dangling-tag property. The
binary artifact layout moved to dist/server/linux/<arch>/pjokk to mirror
GoReleaser's docker build context, so one Dockerfile COPY line serves both
the local script and GoReleaser. Chosen over keeping the bespoke script for
the usual reason: standard tools other developers already know, and less of
our own release plumbing to maintain. Mise gained a task runner section
(`mise run test|check|artifacts|image|snapshot`) — tasks always run with
the pinned toolchain.

## 2026-09-01 — CI restructure: merging is releasing, one suite definition

release.yml now triggers on every push to main: releasable merges
(feat/fix/perf/breaking per svu) tag and publish automatically; docs/chore
merges end green without releasing; the dispatch remains only for dry_run
and allow_major. The PR review is the release approval gate. The test
suite moved into a reusable test.yml called by both ci.yml (PRs) and
release.yml (main) — one definition, no drift, and a merged feature now
runs the suite twice (PR head + merge commit) instead of three times, and
builds artifacts twice instead of three. ci.yml is PR-only, gained a
cancel-in-progress concurrency group and least-privilege permissions, and
its preview tags became semver prereleases: <next>-pr.<n> (moves with the
PR) and <next>-pr.<n>.<sha> (immutable), replacing -preview.<sha> and
branch-<branch>. Accepted residual: the published image is GoReleaser's
build while the smoke test runs on the PR's build-artifacts image — same
Dockerfile, same base digest, same flags; the delta is version-stamping
ldflags, and dockers_v2 pushes the manifest in the same buildx invocation,
so pre-push smoking of the literal artifact is not possible.

## 2026-09-02 — invitee signup (#26, #27): open OAuth accounts, gated families

Closed the loop from issue #26 (a brand-new invitee could not join a family
under `OPEN_SIGNUP=0`) and #27 (the SPA had no signup UI at all, only
Google). Three pieces:

- **OAuth account creation is open even under closed signup.** Limen has no
  per-invite signup gate, and a brand-new invitee's *only* way to get the
  account needed to redeem an invite is to create one — so Google sign-in
  (and any other configured OAuth provider) now creates an account
  regardless of `OPEN_SIGNUP`. Credential (email/password) signup stays
  gated on `OPEN_SIGNUP`, unchanged — it remains the founder-bootstrap
  escape hatch, not a general signup door.
- **What actually stays closed is family creation**, tightened to `sysadmin
  OR (the caller belongs to no family AND OPEN_SIGNUP is on)`
  (`allowOrgCreation`, `apps/server/internal/auth/auth.go`). An uninvited
  OAuth account can sign in but cannot create an organization or reach any
  family route — it can only redeem an invite into an existing family.
- **A public `GET /api/config → { openSignup, oauthProviders }`** lets the
  SPA render the right controls without hardcoding either list: the Login
  screen shows a button per configured provider plus, only when
  `openSignup` is true, a credential "Create account" toggle; Welcome hides
  its create-family form for a family-less non-sysadmin under closed
  signup, since submitting it would just 403.

**Accepted residual risk:** an uninvited OAuth signup produces a real,
inert account — signed in, family-less, unable to do anything — that sits
in the database until it either redeems an invite or ages out. This is a
deliberate reframing of the closed-alpha guarantee: it was never "no
accounts without an invite," it is "no *access* — no family, no child data
— without an invite." The existing nightly orphan-account purge
(`internal/jobs/purge.go`, `orphanGracePeriod` = 7 days, wired into the
`nightly` cron job) already covered post-signup abandonment and needed no
change to also cover this case.

## 2026-09-04 — PWA install: real PNG icons and a state-aware hint

An iPhone user went looking for "Add to Home Screen", did not find it, and
gave up. Investigation turned up four separate defects, none of which any
test covered:

- **`apple-touch-icon` pointed at an SVG**, in both the SPA and the landing
  site. WebKit accepts no SVG there and no SVG in a web app manifest either,
  so an iPhone adding Pjokk to the home screen was falling back to **a
  screenshot of the page** as the icon. Fixed with real PNGs.
- **Nothing in the app ever mentioned installing.** Chromium fires
  `beforeinstallprompt` and hands you a button; WebKit has no equivalent and
  never will, so on iOS the Share-sheet item is the only route — and the app
  said nothing about it, anywhere.
- No `mobile-web-app-capable` / `apple-mobile-web-app-*` meta tags.

**The PNGs are generated, not drawn.** `scripts/gen-icons.mjs` renders them
from the same geometry as `icon.svg`, reusing the hand-rolled PNG writer that
already existed for the landing site's og card — extracted to
`scripts/lib/{png,mark}.mjs` rather than duplicated. No rasterizer joins the
toolchain for four static files, and the output stays reproducible. The arc
centres are now *derived* from the SVG path endpoints (SVG 1.1 F.6.5) instead
of being hardcoded constants with a note to "re-derive them rather than
nudging by eye"; that re-render moves 27 subpixels of 2,268,000 in og.png, by
at most 9/255, all on curve edges — the derived values are the more faithful
of the two. Every PNG is full-bleed: iOS masks an apple-touch-icon itself
(ours would round it twice), a maskable icon must fill its square by
definition, and the encoder writes RGB with no alpha anyway. `icon.svg` keeps
the rounded tile for engines that take an SVG.

**The hint is a state machine, not an `isIOS` flag** — because the wrong hint
is worse than none. Inside a Facebook or Mail webview, "tap Share → Add to
Home Screen" is not merely unhelpful, it is *impossible to follow*: that menu
item does not exist there. `detectInstallState` therefore separates
`ios-safari` (give the steps) from `ios-needs-safari` (say "open in Safari
first", then give the steps), detecting real Safari by requiring BOTH a
`Version/` and a `Safari/` token — Chrome on iOS carries `Safari/` but never
`Version/`. iPadOS is caught by `maxTouchPoints > 1`, since it reports itself
as a Macintosh.

**iOS is checked before a captured prompt.** The two can never both be true on
a real device (WebKit does not fire the event), so the ordering is
unobservable in production — but it makes the browser test deterministic,
where Chromium drives an iPhone user agent.

The detection is a pure function over an env struct, unit-tested across the UA
matrix; everything that reads live browser state is covered by
`e2e/install.spec.ts` instead, since the frontend suite has no DOM. The banner
lives on day-mode Home only (never in the shell, never in night mode), yields
to `UpdateBanner` rather than stacking in the same fixed slot, and its
dismissal is permanent per device — with Settings → Install keeping the
instructions reachable afterwards.

## 2026-09-04 — the landing site moves into the app image as a dispatch mode

The apex was the last thing shipped by hand: CI built `apps/landing/dist`,
uploaded it as an artifact, and "nothing deploys it automatically yet". The
obvious fix was a second image — `ghcr.io/refsdal/pjokk-landing`, a small Go
static server on the same distroless base. It was designed that way and then
rejected in favour of **a sixth dispatch mode on the existing binary**,
`pjokk landing`.

The dispatch table already existed for exactly this, and `healthcheck` was
the precedent: a mode that "constructs NOTHING: no config, no pool, no auth".
`landing` is the same shape — no database, no auth, no API routes, no
scheduler — and it costs one `case` and one embed rather than a second
Dockerfile, a second GoReleaser build, a second image, a second tag ladder, a
second cosign entry and a separate overlay script. It also removes the
possibility of version skew between two artifacts built from one commit.

**The trade accepted:** the most-scanned hostname now runs a binary that
*contains* the API and the Postgres driver. None of it is reachable — landing
mode mounts no API routes and opens no pool — and the same binary already
faces the internet on app.pjokk.no, so this buys one artifact instead of two
for an unreachable-code delta. Image size is the other half of the trade and
is not close: the whole prerendered site is ~60 kB beside a 21 MB binary.

**Configuration moved from build time to runtime**, which is the part that
actually needed designing. `apps/landing/build.ts` gained `TEMPLATE=1`: it
emits `__PJOKK_APP_URL__`, `__PJOKK_SITE_URL__` and
`__PJOKK_CTA_LABEL_{EN,NB}__` where the deployment's own values would go, and
`internal/landing` substitutes them **once at startup** with a single
`strings.Replacer` pass per document — no per-request templating, no HTML
parsing. Without this the image would bake `pjokk.no` in and a second host
would need a second build, which is precisely the build-per-environment
property the app image shed when robots.txt and the security headers moved to
runtime. `robots.txt`, `sitemap.xml` and `X-Robots-Tag` are likewise served
rather than built, gated on `INDEXABLE`, still fail-safe: only `"1"` opts in.

**The CTA label goes through a sidecar rather than into Go.** `OPEN_SIGNUP`
picks "Sign in" or "Get started", in two languages — and duplicating
Norwegian copy into the server would have made `apps/landing/src/copy.ts`
stop being the single source of truth for user-facing strings. The build
writes `cta-labels.json` beside the documents instead, and the server reads
the label out of it. A missing sidecar is a startup error, not a page that
serves `__PJOKK_CTA_LABEL_EN__` as a button.

**The sitemap is derived from the embedded tree**, not from a hardcoded path
list like the TypeScript build's, so a new prerendered document appears in it
without anyone remembering to add it. The format — every document in both
languages, each carrying the same hreflang pair — is unchanged.

**A stricter CSP than the SPA's.** The landing site is zero-JavaScript by
design, so `script-src 'none'`, `connect-src 'none'` and `form-action 'none'`
cost nothing to promise and are worth promising on the public front door.

Two smaller things fell out. `apps/landing/build.ts` now empties `dist/`
first, like vite's `emptyOutDir`: a file one mode writes and the other does
not — `robots.txt` and `sitemap.xml`, which the container serves at request
time — otherwise survived from a previous build and got embedded into the
binary as a stale leftover. And `config.LoadLanding` is a second loader
rather than a flag on `Load`, because the landing mode shares none of the
app's required variables and `Load` would reject a perfectly good landing
deployment for missing all three of them.

**Addendum (same day): `landing` serves `/healthz` and `/readyz`.** Shipped
without them in v0.4.0, which was a plain bug — the image bakes in
`HEALTHCHECK ["/app/pjokk", "healthcheck"]` and that probe runs in EVERY
dispatch mode, so a landing container failed its own healthcheck forever:
`docker ps` showing "(unhealthy)", and an orchestrator that honours health
killing it or never marking it ready. Both probes answer `{"ok":true}`, the
same body package api's do, so one probe definition works against any mode.
Readiness is liveness here — this mode has no database and no dependency that
could be unready — and both are `noindex` regardless of `INDEXABLE`, a probe
endpoint having no business in a search index.

**And a compose file, `docker-compose.landing.yml`, rather than a profile.**
The obvious home was a `profiles: ["landing"]` service in
`docker-compose.yml`, beside the existing `tools` profile. It does not work:
Compose interpolates the whole file before it selects services, so the app's
`${AUTH_SECRET:?...}` guard fails even when the only service asked for is one
that needs no secret — and `.env.example` ships `AUTH_SECRET=` empty, which
`:?` rejects too, so copying it is not a way out either. Previewing a
marketing page should not require generating an auth secret for an app you
are not running. A separate file decouples it completely, and matches the
repo's existing habit of one compose file per audience.

## 2026-09-05 — the theme is decided before the first paint, and the palette is measured

Reported from a real installed app: on an Android phone in **dark mode**, the
status bar went near-white and the clock and notification icons became
unreadable. Light mode was fine.

**Cause: the theme was applied too late.** Both `AppearanceProvider` and
`useNight` set their class and the `theme-color` meta from a `useEffect`,
which runs *after* the first paint. An installed PWA takes its status-bar
colour from that meta, so it always started at the hardcoded light
`#faf9f7`; the system, being in dark mode, drew its light glyphs over it.
The same lateness had a second symptom nobody had reported: **every cold
start in dark or night mode flashed the light theme first** — in an app whose
night mode exists precisely so that a parent at 3am gets near-black and no
blue light.

`public/theme-init.js` now resolves theme and night mode from the same
`localStorage` keys and applies both, plus the meta, before anything paints.

**A separate file, not an inline `<script>`.** The app is served under
`script-src 'self'` with no `'unsafe-inline'` and no hashes
(`internal/web/web.go`). An inline bootstrap would have worked in `vite dev`
and been silently blocked in the container — the worst way to discover a CSP.
The cost is a duplicate of the resolution logic that cannot import from the
bundle; `test/contrast.test.ts` asserts its colours and storage keys still
match the real ones, so the copies cannot drift in silence.

**Then the rest of the palette was measured rather than eyeballed**, which
turned up three more problems of the same family — a light-mode value
inherited by a dark theme that never overrode it:

- **`--color-on-accent` was never overridden in `.dark`.** White text on the
  dark accent is **2.62:1**, below even the large-text floor, on every primary
  button and selected chip. Night mode had already solved this with a
  near-black ink; dark now does the same (6.95:1). The landing site had the
  identical bug on its call to action, on the public front door.
- **Three light-mode category tints sat under 3:1** against the background —
  feed 2.80, growth 2.37, diaper **2.31**. These are not decoration: the tint
  is how a feed is told from a diaper at a glance, which is the entire "status
  before action" premise. Deepened by the minimum that reaches 3:1, hue
  preserved.
- **Night's `--color-muted` was 3.83:1** on cards, under the 4.5 floor for the
  small secondary text it carries — timestamps and "by <caretaker>" — in the
  one mode that exists to be read at 3am.

The numbers are now tests, not an audit: `test/contrast.test.ts` and the
landing's palette tests hold every token pair to WCAG 2.1 (4.5:1 text, 3:1
meaningful graphics), and assert the two copies of the brand palette match.
Hairlines and scrims are deliberately excluded — holding a divider to 3:1
turns it into a border.

**Known limitation, not fixed:** `manifest.theme_color` and
`background_color` are static by specification, so the OS splash screen is
light even in dark mode. Making it dark would only move the mismatch to light
mode. The meta is what governs the status bar of the running app, and that is
now correct from the first frame.

## 2026-09-05 — temperature is a fourth measurement type, and units are canonical

Migrating a real sprout-track database turned up a reading Pjokk had nowhere
to put: **39.4 °C, with the note "Nora var veldig varm så vi tok en temp
sjekk"**. The importer's first answer was to keep it as a note. That is a
worse answer than it looks — a temperature is a number you want to compare
against the last one, and a note is exactly the shape that cannot be.

**A fourth `type` on `measurement_log`, not a table of its own.** A
temperature is structurally identical to the three growth measures already
there: a number with a unit, at a moment, optionally annotated. Making it a
fourth enum member inherits the shared CRUD engine, the log sheet, timeline
rows, CSV export and the nightly backup for the cost of one constraint
(`00004_measurement_temperature.sql`). Nothing that reads growth data needed
touching: the growth chart and the stats weight row already filter
`type = 'weight'`, so a temperature cannot reach the WHO percentile maths.

**Values are stored in the canonical unit; the unit is never a column.**
Weight is kilograms, length and head are centimetres, temperature is degrees
Celsius, and `measurement_log` has no unit column at all — the unit is a pure
function of the type, resolved at the render sites. This is what keeps a
future Fahrenheit (or pounds) preference a *display* concern: it converts at
the edge and touches neither the schema nor a single stored row. The
importer normalises on the way in for the same reason, converting sprout's
`lb`, `in` and `F`.

**Which immediately exposed a bug.** The unit was being re-derived in three
separate places as `type === "weight" ? "kg" : "cm"`. That reads fine with
three types and is silently wrong with four — **the CSV export was writing
every temperature as centimetres**. The knowledge now lives in one table per
language (`MeasurementUnit` in Go, `measurementMeta` in
`lib/measurements.ts`), each carrying the comment that names them as the seam
a units preference hooks into, and the export test pins all four mappings
rather than just the new one. The duplication was the bug; deleting it was
the fix.

**Fever is 38.0 °C inclusive**, the standard infant definition, rendered with
the existing `--color-danger` token rather than a new colour. It appears on
the timeline row and the Home card, because a fever is the one measurement
worth spotting while scrolling back through a sick week.

**The Home card is windowed to 24 hours.** "Status before action" argues for
putting the latest temperature on the home screen; "calm, not cute" argues
against spending permanent space on something that matters a few days a year.
The window settles it, and matches the `Last sleep` card, which also yields
once it is no longer the current state. The summary carries `lastTemperature`
through its own query rather than reusing `ListMeasurements` with `lim=1`:
that query is type-agnostic, so weighing the baby after taking her
temperature would have put 8.4 on the card as if it were degrees.

## 2026-09-05 — the fever card carries a trend, and night mode keeps its ramp

The temperature card answered "how hot is she"; using it during an actual
illness wants "and is it getting worse". So it gained a three-day sparkline
and a status colour — but two things had to be decided rather than assumed.

**The traffic light stops at night mode.** Red / amber / green is the obvious
encoding, and it directly contradicts principle 6: night mode is a single
amber ramp with *no blue light*, because it exists so that a 3am check does
not wake you up — and green suppresses melatonin second only to blue. Night
already collapses every category tint onto one amber (`#c2a06a`); `ok` and
`caution` now join it, and a rising fever keeps `--color-danger`, which in
night is already a warm amber-red rather than a true red. The consequence is
deliberate: **the card is no longer red at 3am**. The direction is carried by
an arrow (↑ → ↓) beside the reading instead.

That arrow is not only a night-mode fallback. Colour alone carrying meaning
fails for red-green colour blindness — and red/green is precisely the pair
that is indistinguishable — so the arrow is the accessible encoding in every
theme, with colour as reinforcement.

**A fever with one reading is `alarm`, not `caution`.** The trend compares the
latest reading to the previous one; with a single reading there is no
direction. Rendering that as reassuring would be a guess in the dangerous
direction, so an unknown direction is treated as rising.

**No backend change.** Measurements are rare — single digits per baby over
months — so the card reads the existing `/api/measurements` list and computes
the trend client-side, rather than teaching `/api/summary` to carry a series.
`lastTemperature` still drives the headline and the card's visibility.

The sparkline is hand-rolled inline SVG, not recharts: the Stats tab pays for
that library deliberately and lazily, and a dozen points on a status card do
not justify it. Its y-domain always contains 38.0 and draws it as a dashed
line, because a squiggle scaled only to its own values has no reference —
"below fever" needs something to be below.

## Help requests (2026-09-06)

**A help request is family state, not a notification.** "Ask for help"
could have been a fire-and-forget push. It is a `help_request` row instead,
because two things wanted persistence: an acknowledgement ("On my way")
that pushes back to the sender, and a card everyone in the family sees
until it is answered. The card reads the row through `/api/summary`'s
`openHelp`, exactly as running sleep and play sessions do.

**Any member may acknowledge; only the sender or an admin may dismiss.**
The target gets the push, but whoever is closer should be able to answer.
Dismissing someone else's call for help is the one thing the feature must
not allow.

**Expiry is a read-side two-hour window, not a job.** The summary query
filters on `created_at`; nothing has to fire for a stale request to
disappear. The nightly job purges rows after seven days purely so the
table does not grow.

**The rate limit is per user, inside the handler.** The existing
`middleware.RateLimit` keys on the client address and runs before the
session is resolved — right for invite-code guessing, wrong for a
household on one IP where the abuse to slow is one person pinging
another. `help.go`'s `hitUserLimit` uses the same key shape against the
same store, keyed on the user id.

**The card breaks the "tints on icons only" rule on purpose.** While open it
has a red border, a radiating ring and a waving hand, in night mode too:
red is not blue light, and a call for help is exactly the case worth waking
someone for. `prefers-reduced-motion` gets the solid border alone. Both
stop the moment someone answers.

**Session-only, no API keys.** The push says who is asking; a `pjk_` key
has no person behind it. Same tier as `/api/push/*`.

**A member without push is not dimmed, only labelled.** The design said
"dimmed"; the first cut used `opacity-60` on the chip label, which washed
out the SELECTED chip (white on accent). The "No notifications" sub-line
carries the information on its own, so the opacity went.

**`openHelp` rides along on `GET /api/summary` for API keys too.** Only
the three help *writes* are session-only. The summary is family state
(like a running sleep), and a Home Assistant dashboard that can show
"Anders needs a hand" is a feature, not a leak — a read-only key already
sees every caretaker's name on every log row.

**The e2e spec is the visual check.** `e2e/help.spec.ts` drives the built
artifact through the whole round trip in two browser contexts (send,
card on both Homes, acknowledge, dismiss) and asserts the open card's
animation classes. It found the headline clipping at phone width before
any person did; a screenshot is not a regression test.

## One version string: image tag, Settings footer, boot log (2026-09-06)

**The version lives in the binary, and nowhere else.**
`internal/buildinfo.Version` is stamped at link time — by
`.goreleaser.yaml` from `{{ .Version }}` for releases, by
`scripts/build-artifacts.sh` from `PJOKK_VERSION` for the CI preview image
— and defaults to `dev`. The Settings footer used to say a hand-kept
"Pjokk 0.1"; it now reads `version` off `/api/me`, which carries
`Deps.Version`. The boot log prints the same string.

**It is deliberately the image tag, verbatim.** A container cannot know
which of its several tags it was pulled by, so the honest value is the one
GoReleaser tags with: `0.8.0` for a release, `0.9.0-pr.42.abc1234` (the
pinned preview tag) for a PR. CI stamps the pinned tag into the binary and
`e2e/install.spec.ts`'s Settings test asserts the footer shows it, so the
tag someone pulls and the version they see under Settings cannot drift.

**OpenTelemetry, when it lands, reads the same variable.** The resource's
`service.version` must be `buildinfo.Version` — not a second `-X` symbol,
not a package.json field, not `git describe` at runtime. Three places
naming one string is the whole point; a second source is a second thing to
drift.

## The e2e suite is many clients, not one (2026-09-06)

**Each test sends its own client address.** Every spec creates a fresh
account and signs in, and credential sign-in is rate-limited per client:
Limen's 5 per 10 s and Pjokk's own 20 per 10 minutes (`api.go`'s
`auth-signin`, in Postgres). From 127.0.0.1 the whole suite was ONE client
with ~19 sign-ins a run — one CI retry anywhere pushed the tests after it
into 429, which is how a flake in `auth.spec.ts` sank `sleep.spec.ts`.

**The stack trusts one proxy hop; the limits are untouched.** The e2e
stack (`scripts/e2e-stack.sh`, the `image` job in `ci.yml`) runs with
`TRUSTED_PROXY_HOPS=1`, and `e2e/fixtures.ts` gives every test — and every
retry, and every extra context a test opens — a distinct `10.x.y.z` in
`X-Forwarded-For`. That is what production behind an ingress looks like
too: a family on one router is many devices, not one. Weakening the limit
for tests, or adding an env knob to do so, would have been the wrong lever;
the smoke test before it still runs the image at its defaults.

## User profile, avatars, and no family in the URL (2026-09-06)

- **`display_name` is a stored generated column** — nickname when set, else
  the full name. Every join that shows a person to their family reads it
  (logs, timeline, summary, CSV export, members, calendar). The session's
  own name, the admin audit trail and the API-key join keep the full name.
  Neither the handlers nor the SPA know the rule.
- **The login email is shown, not edited, and there is no contact email.**
  Limen's `users.email` is NOT NULL, UNIQUE and the credential subject;
  every account today has a real address. A nullable `contact_email` is a
  one-column change if a provider without email ever ships. Deferred, not
  rejected.
- **Phone is private.** Not on `Member`, not in the Caretakers list, not on
  the help card. A "share with my families" toggle is the natural way to
  open that later.
- **Avatars go through the storage port and are re-encoded server-side to
  JPEG.** Proves the bytes are an image whatever the declared type, bounds
  the pixel count from the header before decoding, and strips EXIF (no GPS
  fix reaches the store). They are outside the nightly row dump, like
  vaccine documents. Served only through `/api/users/{id}/avatar`, to the
  owner and to co-members; everyone else gets 404, never 403. Removing a
  photo deletes the object BEFORE clearing the key, so a failed delete
  leaves the key in place and a retry finishes the job.
- **The Google picture is imported once**, on the first `GET /api/me`,
  synchronously with a 3 s cap, host-allowlisted to googleusercontent.com.
  The attempt is marked whatever happens, so a removed photo never comes
  back on the next Google sign-in. The allowlist is re-checked on every
  redirect hop, and the "attempted" mark is an atomic conditional UPDATE so
  two simultaneous first loads cannot both import.
- **No family slug in the URL.** The server resolves the family from the
  session and scopes every query; the client never names one. A URL family
  would be a second source of truth (tabs disagree, a switch per
  navigation, PWA start URL / precache / push links / `/join/CODE` all
  harder) for a switch that happens rarely. The client-side hazards — stale
  family-level caches, replayed offline writes, a second tab — are handled
  by the switch flow (refuse with paused mutations, then `resetCache`) and
  the family fence in the shell (`localStorage` family id vs `/api/me`,
  reset + reload on mismatch). If the fence fires while offline writes are
  queued, they are discarded — the server has already switched and they can
  never be replayed — and the shell says so once after the reload.
- **Nothing else moved out of Settings.** Notifications are per user but
  configured per device; Appearance is per device.
- **The SPA CSP allows `blob:` images.** The on-device avatar crop decodes
  the picked file through an object URL before uploading; `blob:` URLs are
  created by the page itself, so no third-party image load is enabled. The
  landing site's CSP is unchanged.

## 2026-09-07 — detail on the core logs (#43)

The September competitor comparison (issues #43–#54) put one gap first:
every general-purpose tracker records what a bottle held, what the solids
were and whether they caused a reaction, whether a diaper was dry and what
a stool looked like, and whether a sleep was a nap or the night. Pjokk's
sprout-track importer had been meeting all of that data and folding it into
`notes` — which is exactly the shape you cannot count, filter or chart.

- **Six nullable columns, no new tables, nothing required on the wire.**
  `feed_log.contents` (formula | breast_milk | mixed), `feed_log.food`,
  `feed_log.reaction` (boolean), `diaper_log.color`, `diaper_log.consistency`,
  `sleep_log.type` (nap | night), plus `dry` as a fourth `diaper_log.type`.
  NULL means "not recorded" everywhere and renders as nothing; the two-tap
  happy path sends none of them. The PATCH tri-state (omitted = leave,
  null = clear, value = set) applies to each, and switching a feed's type
  from the sheet clears the detail that no longer applies with explicit
  nulls, exactly as `amountMl` is cleared when switching to breast.
- **`reaction` is a nullable boolean, not a severity enum.** The sprout
  data has a flag plus a free-text description; inventing "mild"/"severe"
  on import would have been a guess. The flag is the column, the
  description stays in notes.
- **The sleep field is `type`, not `kind`.** The first cut called it `kind`
  and the timeline test caught it: `kind` is the timeline entry's
  discriminator ("sleep"), and `Set("kind", …)` overwrote it. The feed and
  diaper enums are already `type`, so sleep's is too.
- **The server never defaults the sleep type.** It has no timezone to
  decide "night" with. The SPA defaults it from the device's night-mode
  schedule at the moment the sheet opens (`sleepTypeAt` in `lib/night.ts`,
  schedule only — a manual "night on" at 14:00 is about the screen, not the
  baby), and the chip is one tap away for the 19:00 bedtime the default
  window does not cover. API-key writes that omit it stay NULL, and rows
  from before the column exist as NULL, so the timeline title falls back to
  plain "Sleep".
- **`dry` is its own summary count.** The importer used to demote a DRY
  check to a note precisely because calling it "wet" would inflate every
  wet-nappy count forever; now it is a type with its own `today.dry`, shown
  on the Home card only when non-zero.
- **Colour and consistency are never prefilled**, unlike contents and food.
  Last-value prefill is for things that repeat (the same formula, the same
  puree twice a day); a silently repeated "green · loose" would be a false
  record. They sit behind an "Add detail" disclosure that only appears for
  dirty/both, so the diaper sheet's happy path is unchanged.
- **The CSV keeps its header.** The new detail lands in the existing free
  `detail` column (" · "-joined), so spreadsheets built on the old file keep
  their column positions.
- **The importer maps instead of folding.** bottleType → contents (Milk
  and Other have no counterpart and stay a note), FeedLog.food and the
  FoodLog names → food, hadReaction → reaction, DRY → dry, condition →
  consistency (OTHER stays a note), color → color, NAP/NIGHT_SLEEP → type.
  Quality, blowout, cream and reaction descriptions still ride in notes.

## 2026-09-07 — the nursing timer is family state (#44)

The nursing timer lived in one phone's localStorage (`lib/nursing-timer.ts`):
a co-parent saw "last feed 2 h ago" while the baby was being fed, a phone
swap lost the clock, and the API could start a sleep but not a feed. Ranked
second in the competitor comparison; every app in it shares the timer.

- **A `feed_timer` table, not a `feed_log` row with `end_time IS NULL`.**
  The issue proposed the sleep/play shape. It does not fit: a logged feed
  has one `time`, not a start and an end, so a NULL end could only have
  meant "running" by adding an end column every finished feed would also
  carry. The timer is a different thing from a feed — a running side and
  banked seconds per side — and it BECOMES a feed on stop. One row per
  (baby, kind) with `kind ∈ breast | pump`, so a parent can nurse one side
  and pump the other.
- **The clock is the server's.** The client never sends elapsed time. It
  sends start / switch / pause / stop and the server banks the running
  stretch on `d.Now()` before writing the new state, so two phones agree
  without a clock sync and a Home Assistant automation drives the timer
  with the same calls. The one exception is start: an offline SPA replays
  the moment the parent tapped, via `startTime`.
- **Stop is one transaction with the delete.** The DELETE's rows-affected
  count is the replay guard: a second stop finds nothing to delete, the
  transaction rolls back the feed it just inserted, and the caller gets a
  404 rather than a duplicate — the same property WakeSleep gets from its
  `end_time IS NULL` predicate.
- **The logged feed's time is the timer's start**, not the moment of
  Save, because that is what the duration is measured from and what
  "when did she last eat" should count from. The sheet can still pick a
  time.
- **Minutes from seconds is the sheet's old rule**, now on both sides: a
  side with any seconds is at least one minute, otherwise nearest minute;
  the steppers override the clock through the stop body, because a parent
  who forgot to stop the clock knows better than the clock.
- **A pump timer is one clock.** No pause, no switch; the side is chosen at
  start and can be corrected at stop. Everything it counts banks into
  `leftSec`. Stop opens the pump sheet rather than logging directly: the
  amount is the one thing the clock cannot know.
- **Switch / stop / discard are disabled while the start is optimistic.**
  They need the server-issued id. The start itself is offline-safe (the
  optimistic banner counts from the client's `startTime`), which is the
  case that matters at 03:00 with no signal.
- **The localStorage timer is deleted, not kept as a fallback.** Two
  sources of truth for a clock is the bug this fixes.
- **Screenshots ride on the e2e spec** (`E2E_SHOT_DIR`), as help.spec.ts
  does: the two-context flow is the only place a second phone's banner can
  be seen, so the spec that proves it is also the one that photographs it.

## 2026-09-07 — reminders are a per-user list (#45)

`push_pref` held one integer: "no feed for 3/4/6 h", family-wide. Third in
the competitor comparison; every app there reminds about diapers, pumping
and medicine, at intervals or fixed times, with a night-time switch.

- **A `reminder` table replaces `push_pref`**, migrated in 00009 (each
  non-zero preference becomes one `feed since_last` row, with its latch)
  and the old table dropped. No compatibility endpoint: the SPA ships in
  the same binary as the API, so there is no client to keep the old
  `feedReminderHours` alive for. Personal, not family state — `user_id`
  cascades, so account deletion needs no reassignment branch.
- **Two modes, one latch.** `since_last` is the old rule per kind: fire once
  the newest log of the kind is older than the interval, once per gap (a
  newer log makes `last_fired_at` stale). `at_time` fires once per matching
  local day; the same column latches the day slot. A `custom` reminder is
  always `at_time` — there is nothing to be "since".
- **The timezone lives on the row.** Users have no timezone column and a
  phone can move; `at_minute`, `days_mask` and quiet hours are wall-clock
  ideas and are read in the row's IANA zone, which the SPA sends from
  `Intl`. The binary embeds tzdata (calendar reminders already depended on
  it), so any zone name works in the scratch image.
- **Quiet hours hold, they do not latch.** A gap that comes due at 03:00
  fires at the first tick after 07:00 if still open. The sheet prefills the
  window from the device's night-mode schedule — the hours a parent already
  said they sleep in — and it is one chip to switch off.
- **A missed fixed slot is latched silently after an hour**, as calendar
  reminders are: after a cron outage a late nudge is worse than none. An
  interval gap has no such cutoff; "no feed for 9 h" is worth saying however
  late the cron wakes up.
- **Medicine keys on a name by free text** (case- and space-insensitive),
  or on any dose when no name is given. #49's catalogue can attach an id
  later without changing the rule.
- **GET / POST / DELETE only.** A reminder is cheap enough to recreate that
  an edit endpoint would buy a PATCH tri-state for nothing.

## 2026-09-07 — the nap window is a guide from a cited table (#46)

Napper and Huckleberry lead with "the next nap is around 13:20"; Pjokk's
Awake card showed how long she had been up and left the conclusion to the
parent. Fourth in the competitor comparison.

- **Rule-based, from a cited table, never a prediction.** A typical wake
  window for the age (`data/wake-windows.json`: Cleveland Clinic's
  pediatrician-reviewed table, 2024-04-25, with Helsenorge's "look for
  tired signs" framing quoted alongside) added to the moment of the last
  wake. The copy says "window" and "usual", never "should". The one hole in
  the source (4–5 months) is filled by carrying the shorter 3–4 row, and
  the table stops where the source stops (12 months) — beyond it the line
  is simply absent.
- **A range, not a point.** The issue proposed ±15 min around a point; the
  source gives a range and the line shows it ("Nap window 13:10–14:25").
  Three states from one calculation: upcoming, open ("until 14:25"), past
  ("Past the usual nap window").
- **Silence over guessing.** No birth date, a wake older than 12 h, a wake
  in the future, or an age past the table all render nothing. The line
  lives on the Awake card, which only exists in the day layout, so night
  mode never shows a nap window.
- **Client-side only, per-device switch.** No API change; the switch sits
  in Settings with the one-line disclaimer the feature owes, stored per
  device like night mode. The optional push from the issue is deferred: it
  would need the table on the server, and #45's reminders already cover
  "no sleep logged for N hours" for a parent who wants a nudge.
- **A per-family offset** ("our baby runs 30 min longer") is deferred until
  a real baby shows the table to be wrong for her; a range that wide rarely
  needs it.

## 2026-09-07 — length and head join the growth chart (#47)

Pjokk logged all three growth measures but charted only weight; every
general tracker in the competitor comparison charts all three against
WHO, and the helsestasjon plots exactly these.

- **Two more WHO LMS tables, same provenance as the first.** The weight
  table came from GlobalStrategies/jsgrowup (repackaged WHO igrowup
  tables, BSD-3); `lhfa_*_0_5` and `hcfa_*_0_5` from the same repository
  become `who-length-for-age-lms.json` and `who-head-for-age-lms.json`,
  in the weight file's exact shape (`[L, M, S]` per month, 0–60). Anchors
  checked in the test against the WHO published medians (boys' length at
  birth 49.8842 cm, girls' head at 12 months 44.8965 cm).
- **Month 24 is listed twice in the WHO length table** — recumbent length
  up to 24 months, standing height from 24 on, 0.7 cm apart. The length
  row is kept: it is what Pjokk's `length` type stores, and a toddler
  measured standing is a per-row unit question this table should not
  quietly answer.
- **One percentile function over a type**, `growthPercentile(type, sex,
  age, value)`; the weight wrappers stay so the Stats weight row and its
  tests read as before.
- **One chart, chips for the type**, not three charts. The chips only
  list the types with data, and the chart shows the first type that has
  any, so a family that has only ever weighed sees what it always saw.
- **Not added:** CDC curves and preterm-corrected age. The audience is
  Norwegian and helsestasjonen uses WHO; a corrected age can arrive later
  as a `baby.dueDate` column without touching the charts.

## 2026-09-07 — photos on milestones (#48)

The only files Pjokk stored were vaccine documents (uploads switched off —
a photographed clinic card can carry a fødselsnummer) and avatars. A
"first smile" had nowhere to go. Sixth in the competitor comparison.

- **Milestones only, three per entry.** A photo on every diaper is another
  product's problem; a photo on "first tooth" is the reason a family opens
  the timeline a year later. The timeline row shows the first one at row
  height; the edit sheet shows all three with delete and add.
- **The avatar pipeline, not the document pipeline.** Every upload is
  re-encoded to JPEG on the server: DecodeConfig bounds the pixel count
  from the header, image.Decode proves the bytes are an image whatever the
  declared type, and a JPEG written from pixels carries no EXIF, so no GPS
  fix reaches the store. That is also why `/api/photos/{id}` may serve
  inline where `/api/files/{id}` must say attachment: a stored photo is
  bytes this server produced. The SPA downscales to 1600 px first, the
  same helper vaccine documents use (now `lib/image.ts`).
- **A per-family quota, `PHOTO_QUOTA_MB`, default 500, 0 = off.** Summed
  from the rows on every upload rather than kept in a counter that could
  drift; 413 QUOTA with a message the sheet shows. Settings → Data shows
  "Photos: 12 MB of 500 MB". Under `fs` it is space on the volume, which
  the README says.
- **Copied nightly, not dumped.** The row dump carries a photo's key and
  size; the bytes get one copy each under `photo-backups/current/` (not
  `backups/`, which PruneBackups would eat after 30 days), a deleted
  photo's copy moves to `photo-backups/deleted/<date>/` the next night,
  and that tree is pruned after the same 30 days the row dump keeps —
  which is also the erasure promise, so no longer. Avatars and vaccine
  documents stay outside the backup as before.
- **No `uploaded_by`.** The milestone carries the attribution; a users FK
  would only add a branch to ReassignUserReferences for nothing.
- **Creating with a photo uploads once, online.** The create is queued
  offline like every log, but a File does not survive a reload, so the
  sheet says "add the photo from the timeline later" when there is no
  signal rather than pretending.
- **The privacy policy names attached photos** in both languages, under
  the health-information section, including the 30-day backup copy.


## 2026-09-07 — the medicine catalogue is the family's, not the app's (#49)

- **A `medicine` table per family, with `medicine_log.medicine_id`
  pointing at it.** A dose used to be a free-text name typed every time,
  and the app could not say at 02:00 whether the next paracetamol was
  allowed yet. The catalogue holds what the family knows — the name, the
  usual dose, and their own minimum interval — and the log sheet offers
  it as chips that prefill the stepper. `/api/medicines` is a bespoke
  family entity like contacts (no time, no caretaker); the dose log stays
  at `/api/medicine` and gains a nullable `medicineId` that must name one
  of the caller's family's entries (404 otherwise).
- **No dosing data ships with the app, and nothing ever blocks a save.**
  The interval is entered by the family from the leaflet or the doctor;
  the app adds it to the newest linked dose and shows "Next dose OK from
  HH:MM" in the caution colour on the sheet and on the timeline's newest
  dose, while it is still ahead. Supplements (`is_supplement`) never get
  the line: vitamin D twice in a morning is not what the caution is for.
  A medical table the app owned would be a liability the app cannot
  carry; a number the parent typed is a reminder of their own rule.
- **`lastDoseAt` rides on the catalogue entry, per baby.** `GET
  /api/medicines?babyId=` answers each entry's newest linked dose for
  that baby, so the sheet needs no second query and no client-side scan
  of a paginated log. The catalogue query key is invalidated with the
  logs, which is what keeps the caution correct on the very next open.
- **Deleting an entry keeps every dose.** `ON DELETE SET NULL`, and the
  dose row carries its own `name` regardless — the catalogue is a
  convenience over the log, never its source of truth. Archiving hides an
  entry from the chips and keeps it in Settings, dimmed.
- **The importer maps sprout's `Medicine` table** to catalogue rows
  (`st-med-<id>`, dose where the unit fits, `doseMinTime` "HH:MM" as the
  interval, inactive → archived) and links every imported dose, so the
  chips and the caution work on imported history too.

## 2026-09-07 — nights run noon to noon (#50)

- **A `night` session belongs to the night it started in, and a night
  is local noon to the next local noon.** Stats' day buckets split
  sessions across midnight, which is right for "sleep per day" and wrong
  for "how long was the longest stretch last night?" — a 23:00 bedtime
  and a 02:00 resettle are the same night, not two days. The noon
  boundary is the same fixed offset from the caretaker's `tz` as the day
  buckets, so it inherits the same DST caveat (documented on the schema)
  rather than adding a second kind of boundary. `GET /api/stats` returns
  `nights[]`, one per day of the window **plus the night before it**, so
  a one-day window can still answer "last night" — the night that ended
  this morning began yesterday afternoon, outside the day range. The
  sleep read starts at that noon; the day buckets still clip to the
  window, so nothing leaks.
- **Longest stretch = the longest single `night` session; wakings =
  night sessions minus one.** No inference from gaps, no merging of
  sessions separated by a short gap: the log is the truth, and a parent
  who logged two sessions had a waking between them. Untyped sessions
  count as day sleep, as does everything typed `nap`; the split is only
  ever "night" vs "the rest" so the two tints on the chart stay honest.
- **Not on Home.** The issue floated "Longest stretch last night" on the
  summary card. It was left off: Home is the glance screen and already
  carries the sleep state; the number lives one tab over with its trend.
- **Feeds by type as averages, not a chart.** `avgFeedsByType` on the
  intake card, only the types with any feeds; a stacked feeds chart would
  be the third chart on a screen that is meant to stay minimal.

## 2026-09-07 — what the installed icon can do without a native shell (#51)

- **Manifest shortcuts, an app badge and push actions; nothing else.**
  Widgets, lock-screen live activities, Watch and Siri are native
  extensions and stay on the Phase 7 backlog with the Capacitor shell.
  The three things a PWA can do today all ship as one small door:
  `/home?log=<kind>`, which Home reads on arrival, opens as that sheet,
  and immediately strips from the URL (`replace: true`) so a reload or a
  back-swipe never reopens it. Shortcuts point at it; push actions point
  at it; a future widget would too.
- **The shortcut icons are the app icon.** WebKit-style hosts refuse SVG
  in a manifest, and a changed manifest only reaches an installed Android
  app when the WebAPK regenerates; three extra PNGs were not worth that
  for a menu nobody looks at for long.
- **The badge is a dot, not a count**, set while the selected baby has a
  running sleep, play, nursing or pump session and cleared when it ends —
  or when the shell unmounts (sign-out, no family), so a stale dot cannot
  outlive a session. `navigator.setAppBadge` refusing is silently a no-op;
  it is not worth a toast. Selected baby only: a family with twins would
  otherwise see a dot for a session it cannot see on Home.
- **Push actions carry their own URL**, and the service worker
  *navigates* an already-open window to it rather than only focusing it:
  focusing lands on whatever tab was open, which is not "log feed now".
  A plain tap on the body keeps the old focus-or-open behaviour.
- **No "Snooze 15 min" on calendar reminders yet.** A snooze is server
  state (the reminder job would need a `snoozed_until` to honour) plus an
  authed fetch from the service worker; the issue's other three items
  were free and this one was not. Filed as follow-up material rather than
  shipped as a half.

## 2026-09-07 — search, recurrence and an ICS feed (#52)

- **Timeline search is an ILIKE, not an index.** `?q=` adds one
  `col ILIKE '%term%'` clause per kind to the existing page queries — the
  family scope and the keyset cursor stay exactly where they were — with
  `%`, `_` and `\` escaped so a literal wildcard in a medicine name
  matches only itself. A trigram index can come when a family's log is
  large enough to make this slow; none is yet. The field appears on a tap
  so the default screen keeps its density.
- **A recurring event is one row, expanded on read.** No materialised
  occurrences: editing the series is one write, deleting it is one row,
  and the ICS feed hands the rule to the calendar client as an RRULE
  instead of hundreds of VEVENTs. Occurrences share the id and carry
  `seriesStart`, which is what the edit sheet shows — editing any
  occurrence edits the series, and "this occurrence only" (an exception
  table) is deliberately not v1. `recurrence_until` is inclusive on the
  occurrence's start; the sheet sends the end of the chosen day.
- **The series steps on Europe/Oslo's calendar.** Adding 24 h to a daily
  08:00 event lands it at 07:00 or 09:00 after a DST change; stepping the
  local wall clock does not. Oslo is the product's stated locale and the
  zone the reminder clock already renders in, so `internal/recur` uses it
  for everyone rather than growing a per-family timezone the calendar
  has never needed. Monthly/yearly clamp the day (the 31st recurs on the
  30th, Feb 29 on Feb 28) instead of rolling into the next month.
- **The reminder latch is per occurrence.** For a series `reminded_at`
  holds the START of the last reminded occurrence and the job fires when
  the next occurrence's lead has elapsed and `reminded_at < occurrence`;
  a re-arm (NULL) still means "not yet", and a week of downtime skips the
  missed occurrences rather than firing them late — the same grace rule
  one-offs have. One-offs keep `reminded_at = now` and the SQL-side
  stale-latch as before.
- **The ICS key rides in the query string, through the same middleware.**
  A subscription URL cannot send a header. Rather than a second
  authentication path, the route lifts `?key=` into the Authorization
  header when none was sent and then runs the ordinary key chain — the
  key is checked, expired, touched and read-only-gated exactly as a
  bearer would be. Settings mints a read-only key named "Calendar
  subscription" for it, shows the URL once, and points at API keys for
  revocation; the copy says outright that the link is a password.
- **DTSTART carries a TZID with a static Oslo VTIMEZONE**, so the client
  steps the RRULE on the same local calendar `internal/recur` does; a UTC
  DTSTART would drift the rule an hour at each DST change.

## 2026-09-07 — the persisted cache is keyed on the build; a real error screen

- **What broke.** PR #62 added required fields to `/api/stats`. The
  persisted query cache (IndexedDB, 14 days) restored the previous
  build's Stats snapshot before the network answered, and the new screen
  crashed on `nights.length` — a white page with "Cannot read properties
  of undefined". The persister's `buster` was a hand-bumped "v2" that
  nobody bumped, because nothing made you.
- **The buster is now the build version.** `__PJOKK_VERSION__` is
  defined at Vite build time from the same `PJOKK_VERSION` the Go binary
  is stamped with (build-artifacts.sh in CI; the GoReleaser steps now
  pass it too, since the SPA is built in a before hook). A deploy drops
  the previous build's snapshot; within a build, offline data survives
  reloads exactly as before. The trade: the first open after an update
  fetches everything again — and an update only arrives online, so that
  open is online. No tolerance code for old shapes was added to Stats:
  the cause was the snapshot, and fixing the reader would have left the
  next shape change to find the same trap.
- **A render error is caught, said plainly, and recoverable.** The
  router's `defaultErrorComponent` and an `ErrorBoundary` around the app
  both render one screen: "Something went wrong", the message in small
  type for a bug report, and three buttons in the order they are likely
  to help — try again (remount), reload, and clear saved data and reload
  (keeps the session; the exact remedy for a stale snapshot). The e2e
  spec reproduces the original bug by serving an old-shaped Stats
  response and checks that "Try again" recovers once the real one is
  back.

## 2026-09-07 — imperial units are a display preference; the PDF is built on the device (#53)

- **Units live on the person, not the family, and never on a row.**
  `users.units` (metric | imperial) follows the caretaker across families
  and devices; a Norwegian grandmother and an American parent read the
  same rows in their own units. Every stored value stays in its canonical
  metric unit (2026-09-05), the API speaks metric, and `lib/units.ts` is
  the single place oz / lb / in / °F are derived — cards, timeline,
  Stats (including the growth chart, converted after the WHO maths) and
  the steppers all go through it.
- **Sheets keep canonical state and convert only what was touched.** The
  stepper shows 4.1 oz for a 120 ml prefill but the sheet still holds
  120 ml; only a stepped value is converted back (4.6 oz → 136 ml). A
  naive round trip would have saved 121 ml for a feed nobody changed.
  Imperial steps are what the hand expects: 0.5 oz, 0.1 lb, 0.25 in,
  0.1 °F, over the same clinical ranges as the metric ones.
- **Left metric on purpose:** solids in grams (no imperial kitchen unit is
  standard for baby food), medicine doses (the unit is part of the dose
  the family chose and the catalogue stores), and the CSV export (a data
  file is canonical; the card says so).
- **The PDF is rendered in the browser, never on the server.** jsPDF +
  autotable are lazy-loaded (the SPA is embedded in the binary, so bundle
  size is image size), the data comes from the same reads the screens
  use, and health data never passes through a server-side renderer.
  Tables only: a nurse reads numbers, not sparklines. Norwegian letters
  render through Helvetica's WinAnsi set; the file name slugs ø → o and
  æ → ae because NFD does not decompose them.

## 2026-09-07 — one import writer, readers only against real exports (#54)

- **The writer is shared; a reader is per source.** Everything that must
  not differ between sources — how a timestamp or boolean is rendered for
  Postgres, deterministic ids, the `--resolve-by-email` guard that aborts
  unless exactly one (user, family) matches, `ON CONFLICT DO NOTHING`, the
  baby prelude, the summary — moved out of the sprout-track script into
  `scripts/lib/import-writer.mjs`, and the sprout script became the first
  reader over it. A smoke test with a minimal sprout schema guards that
  move; the full mapping is still exercised by hand against real exports.
- **Baby Buddy is the second reader, written against its source.** Its
  export is the admin's django-import-export CSV: model field names, the
  child as `child_id` + names, timestamps in the server's zone with no
  offset, amounts with no unit. So the reader takes `--tz` and unit flags
  rather than guessing, detects the model from the header row, and keeps
  the "lossy on purpose, preserved in notes" policy.
- **No Huckleberry or Nara reader yet, on purpose.** Their column names
  are not documented anywhere public, and a guessed mapping would silently
  import feeds as diapers. The docs ask for a few anonymised rows of a
  real export; the Baby Buddy reader is the template.
- **Still a CLI that writes SQL, not an upload.** Reading the file before
  applying it is the safety net, and an admin action does not need a
  button.

## 2026-09-08 — a Huckleberry reader from a public export, still no Nara (#67)

- **"Real export" can mean a public one.** The rule from #54 stands — no
  reader without a real file — and a family's own export is not the only
  kind of real file: a Huckleberry owner published theirs (about 3 600
  rows), and four independent parsers of the same format agree with it on
  every shape (eight columns, local time with no offset, the diaper colour
  riding in the Duration column, decimal feet in the growth rows, the
  per-side nursing minutes). The reader cites those sources in its header
  and imports that whole file with nothing skipped. The family's rows were
  not copied into the repo; the fixture is a distilled twenty-one-row
  file with the same shapes.
- **Row ids are a content hash.** Huckleberry's export has no ids, so a
  deterministic id has to come from the row itself; a re-export of the
  same data gives the same ids and stays idempotent.
- **Nara stays unread.** No public export, no public parser; the tools that
  import it keep the format to themselves. The issue narrows to Nara and
  waits for a header row.

## 2026-09-08 — responsive shell: phone, tablet, desktop from one layout

- **Tiers by viewport width, never user-agent.** `md` (768) and `xl`
  (1280) — Tailwind's own — so the CSS side (`md:` / `xl:` classes) and the
  JS side (`lib/layout.ts`, used only for the vaul direction and the
  wide-only Recent query) cannot disagree. A narrowed desktop window is a
  phone; a phone in landscape is not a tablet.
- **The bottom sheet becomes a 420 px right panel at `md`**, in the one
  component that imports vaul. Every sheet was laid out for `max-w-md`,
  so nothing inside them changed. The direction is latched when the sheet
  opens: resizing across 768 px mid-edit keeps the half-filled sheet
  rather than remounting it (the same hazard as the 22:00 night flip).
- **"Left informs, right acts."** Home at `md` puts the status cards on
  the left and the actions on the right edge — the edge the panel opens
  from — so the cards stay readable beside an open sheet. Option B
  (actions across the bottom) lost on the mockups because the panel
  covered its buttons and there was nowhere for the desktop Recent pane.
- **No More button above 768 px.** The three primaries become a row and
  the eleven More-sheet actions unfold beneath them as 44 px row tiles,
  from the SAME `moreActions()` list the sheet renders — a new kind lands
  in both. Row tiles over the sheet's 96 px tiles because they keep the
  hierarchy (three big things, then a list) and fit a 712 px tablet
  without scrolling.
- **Desktop is the tablet tier plus a keyboard.** F / D / S on Home,
  Escape, visible focus rings — and nothing else: no density, no hover
  menus, no master–detail. Touch targets never shrink.
- **The account avatar stays in the baby header; the rail is navigation
  only.**
- **Manifest `orientation: "any"`.** It was `portrait`, which locked an
  installed tablet app in a landscape stand. An already-installed Android
  app only sees this after Chrome regenerates the WebAPK.

## 2026-09-08 — kiosk mode: a care station, not a bigger Home

- **Its own palette.** Round one of the mockups scaled Home up and looked
  like Home; the state was invisible. The kiosk got a cool slate palette
  with a mint accent — a different hue from the warm dark mode and from
  the amber night ramp — so "this is the room's screen" reads from across
  the room. Night still wins at 22:00: `.kiosk` sits between `.dark` and
  `.night` in the stylesheet.
- **One tap and an Undo, no sheet.** Sprout Track's nursery mode logs from
  buttons on the card; that is the genuinely different idea and the
  ergonomic win. Bottle at the last amount, Breast L/R, Wet/Dirty/Both,
  Sleep at the last location. Instant logs get a six-second Undo that
  deletes the row; timers do not (a mis-tap is corrected by tapping
  again).
- **Elapsed time first, clock second.** Sprout makes the clock the hero;
  Pjokk's reason to exist is "how long since", so the 48 px number on each
  card is the elapsed time and the clock is the second-largest thing.
  Compact "1 h 32 min", not Home's "1 hour 32 minutes" — the card has no
  room for the words.
- **Amber from the reminder interval.** The one thing Sprout Track had and
  Pjokk lacked: a card that says "too long". No new setting — the
  signed-in user's own `since_last` reminder is the threshold, exactly as
  the push nudge uses it.
- **A local PIN until spec 3.** Leaving kiosk asks for a 4–6 digit PIN
  stored on the device as a domain-separated SHA-256. A convenience lock
  against toddlers and guests, not a security boundary; the device
  credential in spec 3 replaces it.
- **No scenes, sprites, photos or hue sliders.** Sprout's nursery mode has
  four animated scenes and a settings drawer. Calm, not cute: one palette,
  one fixed idle dim.
- **No server change.** Every card is Home's data through the existing
  offline-resumable mutations; the kiosk logs as the signed-in user and
  Settings says so.

## Landing page refresh (2026-09-08)

The marketing page still described the Phase 1 core loop a year of features
later, and it had no door for a stranger: signup is invite-only, so the only
button was "Sign in".

- **Two doors, still invite-only.** The primary button is unchanged (session
  + `OPEN_SIGNUP` decide it). A second, quieter "Run it yourself" goes to the
  GitHub repository, whose README quick start needs neither an account nor
  an invite. The invite line now says so in words. No "request an invite"
  address was added: the only mailbox that exists is `personvern@`, and
  inventing another on a public page would have been a lie until someone
  reads it.
- **Breadth as one-line tiles, not more `.points`.** Eight features in the
  order a first year unfolds (night mode → nap window → reminders →
  medicine → growth → vaccines → calendar → milestones + the PDF), each an
  icon beside one sentence. Three big `.points` cards stayed the 80 %
  story; a second row of big cards would have been a feature wall. The PDF
  line names helsestasjonen deliberately — that visit asks exactly the
  questions the app answers.
- **One more mock-up, still CSS, still a still.** The care station gets a
  landscape tablet built from the phone mock-up's pieces (same tokens, same
  card rules) so the two age together, but it does not animate: the point
  is the three cards, and a second loop next to the hero's would be noise.
  Below ~460 px of mock-up width the three columns become three rows —
  the phone-portrait reading of the same cards — rather than truncating
  their own button labels.
- **The nap window moved into the hero.** The banner reads "Awake · 1 h
  40 m / Nap window 13:10–14:25" instead of "Sleeping". The guide is the
  feature a stranger has not seen elsewhere; an active sleep session is
  not.
- **Open source and importers live in the privacy band.** "Where your data
  lives" and "you can take it with you" are one promise, so the band
  gained a second paragraph rather than a new section. The technical row
  under it (Docker, CSV, API keys, ICS) is a single muted line: present
  for the parent who will run it, invisible to the one who won't.

## Admin-side family management (2026-09-08)

The operator console could count and destroy families; it could not fix
one. Spec: `docs/superpowers/specs/2026-09-08-admin-family-management-design.md`.
Three decisions that only became visible while building it:

- **An operator never becomes a member, so the invite path needed its own
  auth method.** Limen's `CreateOrganization` always installs its creator as
  the first member, inside its own transaction — there is no ownerless
  organization to create. The first attempt made the sysadmin the creator of
  a family they were building for someone else, which would have handed them
  ordinary in-app access to a child's health record and quietly undone the
  console's metadata-only rule. `auth.CreateEmptyFamily` therefore creates
  and then removes that membership, checked, with its failure being the
  whole call's failure. It deliberately does not go through `RemoveMember`:
  that enforces the last-admin guard, and leaving the family adminless is
  the intended outcome — the invite that follows carries the admin role, and
  the list badges the family until someone redeems it.
- **The last-admin guard is anticipated, not merely caught.** Every console
  mutation writes its audit row first, which is right when the alternative
  is a silent change — but reaching `ErrLastAdmin` that way costs a row
  saying a demotion happened when it did not, and "remove the last admin" is
  the first thing an operator tries on a family that looks wrong. The
  handlers now count admins before writing the row. The guard inside the
  transaction stays authoritative; the pre-check buys a clean trail, not
  correctness.
- **`createAccount` is an explicit flag, not inferred.** Provisioning an
  account whenever the address is unknown would turn a mistyped email into a
  stray user and a family nobody can reach. A 404 is recoverable in one
  keystroke, and the console only reveals the checkbox after the server has
  said there is no such account.

The console stays **metadata-only** — members, babies, invites and keys, and
nothing derived from a log — which is what lets the privacy policy stand
unchanged. Impersonation remains the only route to a family's entries, and it
is audited and shows the family a banner. A structural test
(`apps/frontend/test/admin-family-ui.test.ts`) fails if a screen under
`screens/admin/` ever reads a log endpoint.

## 2026-09-10 — cache headers for the SPA, invite codes out of the backup

- **Content-hashed files are immutable; everything else revalidates.** The
  Go server sent no `Cache-Control` on the SPA at all, so every cold load
  re-downloaded the bundles and any caching proxy in front applied its own
  defaults (Cloudflare, for one, caches `.js` by extension), which could
  hand out a previous build's `push-sw.js` or `theme-init.js` after a
  deploy. Now `assets/*` — Vite names every file there by content hash,
  and `public/` has no `assets/` directory to put an unhashed one there —
  is `public, max-age=31536000, immutable`, and index.html, the service
  workers, the manifest and the icons are `no-cache`. A request for a chunk
  that no longer exists falls back to index.html and gets `no-cache`, never
  the immutable header, so an old tab cannot pin HTML at an asset URL.
- **`no-cache` without a validator is a full re-download.** Embedded files
  have no modification time, so `http.FileServer` sends no `Last-Modified`,
  and nothing computes an ETag. That was already true before this change;
  the files are small and the service worker precaches them. An ETag is the
  upgrade if it ever matters.
- **`family_invite` is left out of the nightly backup.** An invite code is
  a credential and it is the table's primary key, so it cannot be nulled
  the way session and OAuth tokens are; and an invite can be issued for up
  to 720 hours, the whole 30-day retention window, so a snapshot could hold
  a code that still works. Like `impersonation`, the table is not worth
  restoring: after a restore a family admin issues a fresh link.

## 2026-09-10 — kiosk devices and the caretaker selector (spec 3)

- **A tablet is the family's, not a parent's.** Spec 2's kiosk held the
  signed-in person's session: every entry was "by" them, and past the PIN
  the tablet could reach settings, invites and keys. A kiosk is now a
  `device` row with its own credential; the tablet holds no person's
  session at all.
- **A cookie, not a bearer token.** The kiosk loads avatars through
  `<img src>`, which cannot send an `Authorization` header, and page script
  cannot read an HttpOnly cookie. `pjokk_device`: SameSite=Lax, Secure when
  `APP_URL` is https, 400 days (the browser ceiling), re-issued on the first
  use of each UTC day.
- **The code is typed on the tablet.** The request that sets the cookie
  must be the tablet's own: an iPad home-screen app does not share Safari's
  cookies, so a QR opened by the camera would enrol the wrong browser. The
  Settings QR still exists for Android, where the jar is shared.
- **The PIN lives on the server and un-enrols.** Chosen with the code, so
  no device is ever enrolled without one; stored as an HMAC keyed from
  `AUTH_SECRET` and salted with the token hash (known before the
  one-statement enrolment, where the device id is not). Five attempts per
  device per ten minutes, answered with the existing `RATE_LIMITED` code.
- **An allowlist of operations**, for the reason Limen's routes are one: a
  new operation is closed to devices until someone decides otherwise.
- **Attribution rides in the mutation variables.** Read from a global at
  send time, a feed queued offline and replayed after the kiosk dimmed
  would go out as nobody, or the wrong person. `FamilyCtx.UserName` is
  left empty for a device: no handler reads it — a log's caretaker name
  comes from its own join.
- **The amber card gets thresholds, not reminders.** Reminders are a
  person's; a device gets only every caretaker's since-last feed/diaper
  intervals (`GET /api/device/thresholds`) — no labels, schedules or quiet
  hours.
- **Members under `["device", "members"]`.** The shared `["members"]` key
  is never persisted (on a person's session it is identity); on a kiosk it
  is content, and a kiosk that reloads offline must still show who can log.
- **NOT_A_DEVICE is ambiguous, and the cache tells it apart.** A revoked
  tablet's first 401 clears its cookie, so sibling requests sent after it
  answer NOT_A_DEVICE — the same as a tablet made a kiosk the old way. Only
  the revoked one has a cached device, so that is the tell
  (`deviceGateVerdict` in `lib/kiosk-ui.ts`), and a leave in progress
  silences the gate entirely. Found by the two-browser E2E, not by review.
- **The kiosk flag is checked before `AuthGate`.** With a person's session
  gone, the shell's session gate would send an enrolled tablet to sign-in
  before the kiosk redirect ran.
- **Metric on the kiosk.** Display units are a person's preference on
  `/api/me`; a device is not a person. A known v1 limitation.

## 2026-09-11 — admin user support (console spec 2)

Spec: `docs/superpowers/specs/2026-09-11-admin-user-support-design.md`.

- **The system-admin role is revoked over HTTP, never granted.** Granting
  stays a database act. A stolen operator session can then demote, but it
  cannot mint more operators, and "who can be an operator" keeps an answer
  that does not depend on the audit trail.
- **The last-admin guard takes row locks.** Revoking checks that another
  active system admin remains, inside a transaction that first locks every
  active admin row (`LockActiveSystemAdmins`, `FOR UPDATE` in id order).
  Without the lock, two operators revoking each other at the same moment
  would both see the other still standing and leave nobody;
  `TestTwoOperatorsRevokingEachOtherLeaveOneStanding` runs exactly that. A
  revoke also ends the sessions that admin opened by impersonating someone.
- **An email change changes the address and nothing else.** It clears
  `email_verified_at`, and the person keeps their sessions and linked
  Google account. A taken address is checked before the audit row is
  written, so a refused change leaves no trail entry. The unique index is
  still the authority, and a lost race answers the same 409.
- **Session activity is recorded every five minutes.** Limen's default
  interval is 0, which moves `last_access` only when a session's expiry is
  extended, so a phone in daily use showed as idle for days.
  `WithSessionActivityCheckInterval(5*time.Minute)` makes "active 5 min
  ago" true, at the cadence API keys and kiosk devices already use. The
  page names a session by its browser and device only; no token and no
  address digest leave the server.
- **The tombstone is not a person.** It is left out of the users list, and
  its detail page is a 404.
- **Keyset paging on all three lists.** The cursor is `(created_at, id)`,
  and each query fetches one row beyond the limit to know whether there is
  more. An offset would skip or repeat rows as the append-only audit table
  grows under the operator. Search is server-side, debounced in the page.
  This retires the "no pagination" debt spec 1 left.
- **The console is partly translated.** The new pages use `t()` like the
  family pages, but the i18n check skips `screens/admin/`. They stay
  English until someone translates them, and nothing fails meanwhile.


## 2026-09-11 — admin ops (console spec 3)

Spec: `docs/superpowers/specs/2026-09-11-admin-ops-design.md`.

- **Run records and the lock live in Postgres.** In a split deployment
  the process answering `/admin` is not the one running the jobs — a
  `worker` replica or CronJobs are — so "did last night's backup happen"
  cannot come from memory. Every run goes through `cron.Claim`: a per-job
  `pg_try_advisory_lock` on a connection held for the run, and a
  `job_run` row. Rejected: a queue the scheduler polls (a CronJob-only
  deployment has no poller) and no table at all (it cannot say whether
  reminders ran).
- **The lock stops overlap, not repetition.** Two replicas ticking at the
  same minute now run the job once, but a quick run that finishes before
  the second tick starts still runs twice. It is not a licence to
  schedule from several places. A held lock is success for the scheduler
  and `pjokk cron` (exit 0): the job IS running, with its own row.
- **Claim, audit, Begin.** The console claims first so a 409 is honest
  and the audit row can name the run, then writes the audit row, then
  starts the job. A failed audit write abandons the claim (row deleted,
  lock released), so no run starts without a trail entry, and a refused
  run leaves no audit row claiming it happened.
- **"Interrupted" is read, not written.** A process that dies mid-run
  leaves its row unfinished; the session-scoped lock dies with its
  connection. The Ops page calls a row still running past its job's
  timeout (1 h nightly, 10 min frequent — the same timeouts that now
  bound every run) interrupted.
- **Stale is 26 h for nightly, 30 min for frequent, and "never run" is
  stale** — that is what a deployment with nothing scheduling looks like.
- **Backups can be downloaded from the console.** The operator chose it
  knowing a snapshot is every family's data. The route is audited before
  the first byte, `Cache-Control: no-store`, and the SPA saves it through
  fetch → blob rather than a navigation. The privacy policy says so, in
  both languages; that a downloaded copy stays in the EU and is deleted
  afterwards is a promise the operator keeps, not one the code can.
- **The service worker and the persisted cache no longer hold admin
  responses.** Found while designing the download: the NetworkFirst rule
  cached every `/api/` GET but auth and `/api/me` for 14 days, and the
  IndexedDB snapshot persisted every query but identity — so other
  people's emails, their sessions and the audit trail sat in an
  operator's browser. `/api/admin/` is now excluded from both.
- **The storage description is shown, never the credentials.** Bucket,
  region and endpoint host (or the fs path) let an operator check the
  EU-residency promise from the console instead of taking the deployment's
  word for it.
- **Two structural notes.** `goose_db_version` is read with a raw query:
  no migration creates it, so sqlc cannot type-check against it. And the
  cron package's tests moved to `package cron_test`, with the unexported
  seams in `export_test.go`, because `internal/api` now imports `cron` and
  an in-package test importing the test rig would be an import cycle.

## 2026-09-11 — restore (console spec 4)

Spec: `docs/superpowers/specs/2026-09-11-admin-restore-design.md`.

- **A family restore undoes a deletion, and nothing else.** It only brings
  back a family that no longer exists, with its original ids, so it can
  neither clash with nor overwrite live data. Rolling a live family back was
  rejected: it destroys whatever was logged since the snapshot. It runs from
  the console (Ops → a snapshot → Deleted families, which shows who deleted
  each family and when — the console's delete is the only path that removes
  one) and from `pjokk restore family`, through the same code.
- **The whole restore only goes into an empty database.** `pjokk restore`
  migrates, then refuses a database with a family or a real user. No
  `--replace`: starting over means a fresh `DATABASE_URL`, so a mistyped one
  cannot wipe production.
- **The schema drives the loader.** Tables load parents-first from the live
  foreign keys, and each is `INSERT … SELECT … FROM
  json_populate_recordset(NULL::t, $1)` over only the columns the snapshot
  carries: Postgres types every row, a column the table lost is ignored, a
  column it gained takes its default (naming it explicitly would insert
  NULL), and the generated `display_name` is never written. Rejected:
  per-table restore code (a forgotten table silently loses data) and SQL
  for review (the scratch image has no psql).
- **Every table must declare how a family restore treats it.** Scoped by a
  family id, reached through a parent that has one, never for a family
  (`api_key`, `device`, `push_subscription` — credentials and device
  bindings stay gone), or global. A new table that is none of these fails
  `TestEveryTableHasAFamilyRestoreRule`.
- **People deleted since the snapshot.** Their own rows (membership and its
  roles, reminders, push prefs, calendar assignments) are dropped; every
  other reference is credited to the tombstone — the rule account deletion
  already applies. A family can come back with no admin left; the report
  and the console's "no admin" badge say so. A slug taken since becomes
  `<slug>-restored`.
- **The tombstone is replaced, not skipped.** A fresh database already has
  the migration-seeded "Deleted user"; the whole restore deletes it inside
  its transaction and loads the snapshot's, so a round trip is exact. The
  test compares every backed-up table before and after.
- **Sessions are never restored,** and passwords never were backed up, so a
  whole restore signs everyone out and disables every password.
  `pjokk set-password <email>` reads a new one from stdin — never argv,
  which lands in shell history and process lists — and applies the app's
  password policy.
- **A snapshot from a newer schema is refused.** Loading it into an older
  build would drop its newer columns without a word. Snapshots now record
  their `schemaVersion`; older ones load with a warning.
- **The console's audit row is inside the restore's transaction,** so it
  exists exactly when the restore does. The CLI's family restore writes
  none — `admin_audit` names an operator account and a shell has none — and
  prints its report instead.
- **The privacy policy** now says backups are also used "to undo a deletion
  made by mistake — never one you asked for", in both languages.

## 2026-09-11 — calendar: this occurrence only (follow-up to #52)

Spec: `docs/superpowers/specs/2026-09-11-calendar-occurrence-exceptions-design.md`.
Built without a design conversation, on the owner's instruction to make
the calls and report them afterwards.

- **Skips, not overrides.** One occurrence leaves a series as a
  `calendar_event_skip` row. Deleting "this event" writes one. Editing
  "this event" writes one and creates a standalone event from the series'
  fields with the edit applied (babies, assignees and reminder copied, the
  series' creator kept). Every reader already handles one-off events, so
  the detached one needs nothing new. Rejected: per-field overrides on an
  exception row, which every reader, the reminder job and the ICS feed
  (RECURRENCE-ID) would have to learn to merge.
- **Two scopes, "This event" and "All events", and the sheet defaults to
  "This event"** — it is the occurrence that was tapped. "This and
  following" is not offered: ending a series is its Until date.
- **The API is the existing routes plus `?occurrence=`.** Without it
  PATCH and DELETE act on the series as before, so no old client changes
  meaning. A time that is not an occurrence (off the rule, past Until,
  already skipped, or the event does not repeat) is 400
  `NOT_AN_OCCURRENCE`.
- **Skips survive series edits unless the occurrences move.** A real
  change to the series' start or rule makes a different set of
  occurrences, so its skips are deleted; an unchanged `startTime` — the
  sheet sends it on every save — keeps them, as does a new Until.
  Detached events always stay.
- **The feed lists skips as EXDATE** in the same form as DTSTART (a date
  for all-day events, local Oslo time with a TZID otherwise), and the
  reminder job steps past a skipped occurrence to the next.
- **The new table carries `family_id`,** so the nightly backup lists it
  and a family restore brings it back with its family.

## 2026-09-11 — last night's longest stretch on Home

A follow-up the competitor series deferred: Stats had last night's longest
stretch, but the glance at Home did not.

- **One number, the Stats rule.** `/api/summary` gains
  `lastNightLongestMin` beside `lastNightMin`: the longest single completed
  `night` session of the same noon-to-noon night — what Stats calls the
  longest stretch — and null exactly when the total is.
- **On the awake card's sub-line, only for a broken night.** Home and the
  kiosk read "2 naps · 1:45 today · night 10:30 · longest 6:30"; for one
  unbroken session the longest would repeat the total, so it is left out.
  Wakings stay on Stats — the line is one truncated line, and the E2E
  checks the longest part still fits a phone.

## 2026-09-11 — the SPA's types come from the spec

The Go migration left `packages/shared/src/schemas.ts` behind on purpose (the
entry above calls it "a known and deliberate loose end"): 937 lines of zod
that validated nothing and duplicated the generated `api-schema.d.ts`, free
to drift from the spec without anything noticing. This closes it.

- **The generated file moved into `packages/shared`,** which is now the
  TypeScript side of the API contract: `api-schema.d.ts` (openapi-typescript
  output, still excluded from biome and still byte-identical on
  regeneration) and `index.ts`, which names its schemas (`Baby`,
  `CalendarEvent`, …) and nothing more. A wire type is changed in the spec
  and nowhere else.
- **Enums the spec declares on a field** (`MeasurementType`,
  `ContactIcon`, `TimelineFilter`, …) are derived from that field, and the
  two the SPA needs at runtime (`measurementTypes`, `contactIcons`) are
  written out through a helper that fails the typecheck if the list and the
  spec disagree in either direction.
- **The timeline's rows are the one type rebuilt rather than aliased.**
  The spec models `TimelineEntry` as an open object on purpose — oapi-codegen
  has no clean Go shape for eleven variants — so its generated type cannot
  narrow on `kind`. Every row is one of the log schemas plus its kind, and
  `index.ts` builds the discriminated union from exactly those schemas;
  `timelineKinds` fails the typecheck if the spec gains a kind the union
  lacks. Changing the spec instead would have reshaped the Go server.
- **Nothing else changed shape.** The other 66 importing files typecheck
  against the aliases unchanged: the zod layer and the spec had not yet
  drifted — the point was to stop them ever doing so.
- **zod, react-hook-form and @hookform/resolvers are now unused** by any
  source file. They stay in `package.json` for now: CLAUDE.md names
  react-hook-form + zod as the forms stack, and dropping a decided
  dependency is its own decision.

## 2026-09-11 — each workspace declares its own dependencies

- **The root manifest held the SPA's runtime dependencies** while
  `apps/frontend/package.json` listed three — a leftover from before the
  repo had workspaces. Now each workspace declares what its own code
  imports: `apps/frontend` its runtime packages (20) and its build tooling
  (vite and its plugins, Tailwind, the React and qrcode types),
  `apps/landing` react and its types, and the root only repo-wide tooling
  (biome, TypeScript, Playwright, the bun/node types) plus `web-push` for
  `scripts/gen-vapid.mjs`. `workbox-window` sits with the frontend although
  no file names it: `virtual:pwa-register` pulls it in at runtime.
- **zod, react-hook-form and @hookform/resolvers are gone.** Nothing
  imported them once the shared types came from the spec, and no form in
  the app ever used react-hook-form; CLAUDE.md's stack line now says what
  the forms actually are.
- **The "hoisted" linker stays.** It gives the flat node_modules the scripts
  and CI were built against. Bun's "isolated" default for workspaces would
  additionally fail any import a package has not declared — worth having,
  and a change of its own.
