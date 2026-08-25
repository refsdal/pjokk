# Phase 9 — Stripe Billing (Premium) — Design

Date: 2026-08-25
Status: approved

## Summary

Freemium billing for Pjokk. The free tier keeps the entire core loop
(logging, timeline, week stats, push, night mode). **Premium** — 20 kr/mo ·
200 kr/yr · 400 kr lifetime — unlocks growth charts, API keys, CSV export,
and the stats month view. Integration is the official `@better-auth/stripe`
plugin with **organization-level subscriptions**: the family owns the
entitlement, the purchasing user owns the payment relationship.

Mental model: **users pay, families are Premium.**

## Decisions (settled with the user)

- **Integration:** `@better-auth/stripe` plugin (not hand-rolled), consistent
  with the better-auth-first architecture. Subscription `referenceId` = the
  organization (family) id.
- **Plan name:** "Premium" (not "Plus") in all code, plan values, and copy.
- **Downgrade behavior:** soft lock, keep data. On lapse the family drops to
  `free`: gated UI shows upgrade prompts, existing API keys stop
  authenticating but remain in the DB, nothing is deleted, everything
  reactivates on resubscribe.
- **Everyone starts free.** No grandfathering of closed-alpha families; the
  sysadmin plan override is the escape hatch for comping.
- **No trial.** At 20 kr/mo the price is the trial. Promos can be Stripe
  dashboard coupons later, zero code.
- **Tax:** Stripe Tax is enabled in the dashboard; products/prices already
  created there. Prices must have **inclusive** tax behavior (20 kr shown =
  20 kr charged, MVA broken out). Nothing in app code handles tax.
- **Currency:** NOK only. Currency options can be added to the same price
  objects later without code changes.
- **Price IDs via env vars**, not fetched from Stripe's API: the plugin needs
  them at per-request construction time, env vars give natural test/live
  separation, and price changes mint new IDs anyway. Revisit with
  `lookup_key` + KV cache only if price rotation becomes a habit. Displayed
  prices in the UI are hardcoded i18n strings.
- **Admin scope (Phase 9):** minimal audited plan override only. Full billing
  tab + coupons in /admin remain post-Phase 9 per the roadmap.

## Plan model

`organization.plan` (existing text column, currently always `"free"`) is the
single source of truth the app reads. Values:

| value      | set by                                   | meaning                        |
|------------|------------------------------------------|--------------------------------|
| `free`     | default; webhook downgrade; admin        | core loop only                 |
| `premium`  | webhook (subscription active)            | monthly/yearly subscription    |
| `lifetime` | webhook (`checkout.session.completed`, payment mode) | one-time 400 kr, permanent |
| `comp`     | sysadmin override only                   | complimentary Premium          |

Transition rules (invariants):

- Subscription-active events set `plan = "premium"`.
- Subscription canceled/expired events set `plan = "free"` **only if the
  current value is `"premium"`** — `lifetime` and `comp` can never be
  clobbered by a stray subscription event.
- `lifetime` is written exactly once by the lifetime checkout webhook.
- `comp` (and reset to `free`) are the only values the admin override can
  write; Stripe-derived values cannot be hand-set.

The plugin's own `subscription` table holds detailed Stripe state; `plan` is
the denormalized answer to "can this family use Premium features".

## Stripe integration

**Packages:** `stripe` + `@better-auth/stripe`, versions compatible with
better-auth 1.7.1.

**Plugin config** (inside the existing per-request `createAuth(env)` factory —
Stripe client constructed per request, required on Workers anyway):

- One plan `premium` with `priceId` = `STRIPE_PRICE_PREMIUM_MONTHLY` and
  `annualDiscountPriceId` = `STRIPE_PRICE_PREMIUM_YEARLY`.
- `authorizeReference`: caller must be an admin/owner member of the
  organization used as `referenceId`.
- Webhook route is plugin-registered under `/api/auth/stripe/webhook`
  (already in front of session middleware). `STRIPE_WEBHOOK_SECRET` verifies
  signatures.
- Lifecycle hooks (`onSubscriptionComplete`, `onSubscriptionUpdate`,
  `onSubscriptionCancel`/expire) apply the plan-transition rules above.

**Lifetime:** custom `POST /api/billing/lifetime` (family-scoped, admin-only)
creates a Checkout Session with `mode: "payment"`,
price `STRIPE_PRICE_PREMIUM_LIFETIME`, and the family id in
`client_reference_id` / metadata. The `checkout.session.completed` event is
handled via the plugin's `onEvent` passthrough (same webhook, same signature
verification) and sets `plan = "lifetime"`. Idempotent: re-delivered events
are no-ops once the plan is already `lifetime`.

**Secrets/vars** (SCREAMING_SNAKE, `wrangler secret put`, mirrored in
`.dev.vars` with `.dev.vars.example` documenting each):
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PREMIUM_MONTHLY`,
`STRIPE_PRICE_PREMIUM_YEARLY`, `STRIPE_PRICE_PREMIUM_LIFETIME`.

**Early verification (spike-first, like the web-push check):** before any UI
work, verify `@better-auth/stripe` under `nodejs_compat` — specifically
webhook signature verification, which on Workers must take Stripe's async
WebCrypto path (`constructEventAsync`). If the plugin trips, fallback is
hand-rolling only the webhook route while keeping plugin checkout. Outcome
recorded in DECISIONS.md.

## Entitlements

`src/worker/entitlements.ts` grows up:

- `type Feature = "growthCharts" | "apiKeys" | "csvExport" | "statsMonth"`.
- `canUse(family, feature)` consults a per-feature map; today every feature
  maps to "any non-free plan" (`plan !== "free"`), the map exists for future
  per-feature flexibility.
- `requireFamily` middleware loads `plan` into context once, so gates cost no
  extra D1 read.

**Server gates** (defense in depth; 402 + `{ code: "plan_required" }` body):

| surface | gate |
|---|---|
| `POST /api/keys` (create) | 402 on free |
| `middleware/api-key.ts` (consume) | existing keys stop authenticating on free (soft lock) |
| `GET /api/export.csv` | 402 on free |
| `GET /api/stats?days=30` | 402 on free (`days=7` stays free); gate inside handler after validation |
| growth charts | no server surface (client-side WHO math) — client-only gate, accepted |

## Client

- New `useFamily()` hook in `src/web/lib/data/family.ts` over the existing
  (currently unused) `GET /api/family`, exposing `plan` app-wide.
- Locked states, all deep-linking to Settings → Billing:
  - Stats: growth chart area becomes an upgrade teaser card; month chip gets
    a lock glyph and opens the upgrade prompt instead of switching.
  - Settings: API keys section and CSV export row show upgrade prompts on
    free (CSV especially — it's a `window.location.assign` navigation where a
    402 would render as a raw error page, so it must be pre-checked client-side).

## Billing UI (Settings)

`BillingSection.tsx` in `src/web/screens/settings/`, slotted between
Appearance and API keys. Visible to all members; purchase/manage actions
admin-only (existing `isAdmin` flag).

- **Free:** current plan row + upgrade card listing Premium features and the
  three price options (20 kr/mo · 200 kr/yr · 400 kr lifetime, i18n strings).
  Monthly/yearly → plugin client `subscription.upgrade({ plan: "premium",
  annual, referenceId: familyId })` → Checkout redirect. Lifetime →
  `POST /api/billing/lifetime` → Checkout redirect.
- **Premium:** plan row showing source (monthly/yearly/lifetime/comp);
  subscriptions get a "Manage subscription" row opening the Stripe Customer
  Portal (cancel, card update, invoices — all Stripe's UI, we build none).
  Lifetime/comp show no manage action.
- **Return flow:** success/cancel URLs land on
  `/settings?billing=success|canceled`; success shows a toast and refetches
  `useFamily()` with a short bounded retry (~10 s) until `plan` flips, since
  the webhook can lag the redirect.
- All new strings get `nb` entries in `lib/i18n.ts` (CI guard enforces).

## Ownership edge cases (accepted, recorded)

1. **Second admin subscribes while already Premium:** UI hides upgrade when
   `plan !== "free"`; plugin also rejects a duplicate active subscription for
   the same `referenceId`. No double billing.
2. **Purchaser leaves/is removed from the family:** their subscription keeps
   paying and only they can manage it. Accepted at this scale — they cancel
   via their own portal, family drops to free on the webhook; the admin
   override is the support escape hatch. No code to block removal.
3. **Purchaser's account is deleted:** the admin user-delete flow cancels any
   active Stripe subscription for that customer before deletion (in scope for
   Phase 9, since the flow already exists).
4. **Lifetime purchaser leaves:** family keeps `lifetime` — deliberate; it
   matches what "lifetime" means to a buyer sharing the app with a partner.

## Admin override

- `POST /api/admin/families/{id}/plan` behind existing `requireSysadmin`;
  body `{ plan: "free" | "comp" }` only.
- Audited as `billing.plan.set`, target = family id (free-form action string,
  no schema change).
- UI: small plan control next to the plan badge on the /admin Families screen.

## Testing (vitest-pool-workers, real runtime)

- `canUse` feature map + plan-transition invariants (webhook sets `premium`;
  cancel downgrades only from `premium`; `lifetime`/`comp` immune).
- Each server gate: 402 with `{ code: "plan_required" }` on free, passes on
  premium (keys create, CSV export, `stats?days=30`).
- API-key consumption middleware: valid key rejected on free family, accepted
  again on premium (soft-lock round trip).
- Admin override: sysadmin-only, accepts only `free|comp`, writes audit row.
- Webhook handling: synthesized events, real signature verification where
  feasible, Stripe network calls mocked.

## Out of scope (explicitly)

- Coupons and the full /admin billing tab (post-Phase 9 per roadmap).
- Trials, proration UI, multi-currency, per-feature plans.
- Test environment (app-test.pjokk.no) — separate discussion after this
  ships.
