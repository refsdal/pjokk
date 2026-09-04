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
