# Stripe Premium Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freemium billing — Premium (20 kr/mo · 200 kr/yr · 400 kr lifetime) via the `@better-auth/stripe` plugin with organization-level subscriptions and customers, gating growth charts, API keys, CSV export, and stats month view.

**Architecture:** The plugin handles checkout/webhooks/portal under `/api/auth/*`; its lifecycle hooks write a denormalized `organization.plan` column (`free|premium|lifetime|comp`) that all gates read via `canUse()`. A small custom route handles the one-time lifetime payment through the same webhook. Server gates return 402 `PLAN_REQUIRED`; the client reads `plan` from a new `useFamily()` hook.

**Tech Stack:** Cloudflare Workers, Hono + @hono/zod-openapi, better-auth 1.7.1 + @better-auth/stripe, stripe SDK ^22, Drizzle/D1, React + TanStack Query, vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-08-25-stripe-billing-design.md` — read it first; it argues every decision below.

## Global Constraints

- Plan name is **"Premium"** everywhere; plan column values exactly `free | premium | lifetime | comp`.
- Error body for plan gates: HTTP **402** with `{ error: "Premium required", code: "PLAN_REQUIRED" }` (codes are UPPER_SNAKE in this codebase).
- Never initialize better-auth or the Stripe client at module scope — D1 bindings only exist in-request (`createAuth(env)` factory pattern).
- Every user-facing string goes through `t()` and needs an `nb` entry in `src/web/lib/i18n.ts` — CI (`pnpm check`) fails otherwise.
- Env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PREMIUM_MONTHLY`, `STRIPE_PRICE_PREMIUM_YEARLY`, `STRIPE_PRICE_PREMIUM_LIFETIME` — secrets via `wrangler secret put`, mirrored in `.dev.vars` / `.dev.vars.example`.
- Commit style: Conventional Commits, `Phase 9` noted in body, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Tests run in the real Workers runtime: `pnpm test` (vitest run). Type/lint/i18n: `pnpm check`.
- `src/worker/db/auth-schema.ts` is hand-maintained (header warns the better-auth CLI would overwrite it) — edit manually.
- Migrations are hand-written SQL files in `migrations/`, next number is `0007`.

---

### Task 1: Dependencies + env plumbing

**Files:**
- Modify: `package.json` (via pnpm add)
- Modify: `.dev.vars.example`, `.dev.vars`
- Modify: `vitest.config.ts` (miniflare bindings)
- Create: `src/worker/stripe.ts`
- Modify: `worker-configuration.d.ts` (via `pnpm cf-typegen`)

**Interfaces:**
- Produces: `createStripe(env: Env): Stripe` from `src/worker/stripe.ts`; `Env` gains the five `STRIPE_*` string members.

- [ ] **Step 1: Install packages**

```bash
pnpm add stripe @better-auth/stripe
```

Check the installed `@better-auth/stripe` version is 1.7.x matching `better-auth ^1.7.1` (`pnpm list better-auth @better-auth/stripe stripe`). If pnpm warns about peer mismatch, pin `@better-auth/stripe@1.7.1`. If the postinstall build script for stripe is blocked by pnpm's allowBuilds config, add it the same way existing entries are handled in `package.json`/`pnpm-workspace.yaml` (see the `ci: fix pnpm allowBuilds` commit f4f9015 for the pattern).

- [ ] **Step 2: Add env vars to `.dev.vars.example`**

Append to the comment block and the var list (mirroring the VAPID pattern):

```
#   wrangler secret put STRIPE_SECRET_KEY        (sk_live_… — use sk_test_… locally)
#   wrangler secret put STRIPE_WEBHOOK_SECRET    (whsec_… from the dashboard webhook endpoint)
#   wrangler secret put STRIPE_PRICE_PREMIUM_MONTHLY
#   wrangler secret put STRIPE_PRICE_PREMIUM_YEARLY
#   wrangler secret put STRIPE_PRICE_PREMIUM_LIFETIME
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PREMIUM_MONTHLY=
STRIPE_PRICE_PREMIUM_YEARLY=
STRIPE_PRICE_PREMIUM_LIFETIME=
```

Add the same keys to the local `.dev.vars` (values may stay empty for now; the user will fill in test-mode values).

- [ ] **Step 3: Add test bindings in `vitest.config.ts`**

In the `bindings:` object after `VAPID_PRIVATE_KEY`, add:

```ts
STRIPE_SECRET_KEY: "sk_test_fake",
STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
STRIPE_PRICE_PREMIUM_MONTHLY: "price_test_monthly",
STRIPE_PRICE_PREMIUM_YEARLY: "price_test_yearly",
STRIPE_PRICE_PREMIUM_LIFETIME: "price_test_lifetime",
```

(Constructing a Stripe client with a fake key makes no network calls; only tests that would actually call Stripe need care — none will.)

- [ ] **Step 4: Regenerate Env types**

Run: `pnpm cf-typegen`
If the generated `Env` does not pick up the new `.dev.vars` keys, add them to the same place the existing secrets (`BETTER_AUTH_SECRET` etc.) are typed in `worker-configuration.d.ts` following the file's existing pattern.

- [ ] **Step 5: Create the Stripe client factory `src/worker/stripe.ts`**

```ts
import Stripe from "stripe";

// Request-scoped like everything else on Workers. The fetch-based HTTP
// client + async webhook crypto are what make the SDK work here.
export function createStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-06-24.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
  });
}
```

If the installed SDK's type for `apiVersion` rejects that literal, use the literal the SDK's types export (the pinned default) — do not cast to `any`.

- [ ] **Step 6: Verify everything still builds and passes**

Run: `pnpm check && pnpm test`
Expected: PASS (no behavior change yet).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .dev.vars.example vitest.config.ts src/worker/stripe.ts worker-configuration.d.ts
git commit -m "chore(billing): add stripe SDK + better-auth stripe plugin deps and env plumbing" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema + migration (subscription table, stripeCustomerId columns)

**Files:**
- Modify: `src/worker/db/auth-schema.ts` (user + organization tables, new subscription table)
- Create: `migrations/0007_phase9-billing.sql`

**Interfaces:**
- Produces: `schema.subscription` (Drizzle table, exported via the existing schema barrel), `schema.user.stripeCustomerId`, `schema.organization.stripeCustomerId`. Column names snake_case, timestamps `integer(..., { mode: "timestamp_ms" })` like the rest of the file.

- [ ] **Step 1: Add columns + table to `auth-schema.ts`**

In the `user` table add:

```ts
stripeCustomerId: text("stripe_customer_id"),
```

In the `organization` table (after `plan`) add:

```ts
stripeCustomerId: text("stripe_customer_id"),
```

After the `invitation` table, add the plugin's subscription table (field list from the plugin docs):

```ts
export const subscription = sqliteTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    plan: text("plan").notNull(),
    // The family (organization) id. Non-unique: resubscription after a
    // cancellation creates a new row.
    referenceId: text("reference_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").notNull(),
    periodStart: integer("period_start", { mode: "timestamp_ms" }),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }),
    cancelAt: integer("cancel_at", { mode: "timestamp_ms" }),
    canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    seats: integer("seats"),
    trialStart: integer("trial_start", { mode: "timestamp_ms" }),
    trialEnd: integer("trial_end", { mode: "timestamp_ms" }),
    billingInterval: text("billing_interval"),
    stripeScheduleId: text("stripe_schedule_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("subscription_reference_idx").on(table.referenceId)],
);
```

Confirm the schema barrel (`src/worker/db/index.ts` or wherever `schema` is assembled) re-exports everything from `auth-schema.ts` automatically (it does for existing tables — verify `subscription` appears on `schema.`).

- [ ] **Step 2: Write `migrations/0007_phase9-billing.sql`**

```sql
-- Phase 9: Stripe billing. Plugin-managed subscription state + per-entity
-- Stripe customer ids. organization.plan (added in 0000) becomes live.
ALTER TABLE `user` ADD COLUMN `stripe_customer_id` text;
ALTER TABLE `organization` ADD COLUMN `stripe_customer_id` text;
CREATE TABLE `subscription` (
  `id` text PRIMARY KEY NOT NULL,
  `plan` text NOT NULL,
  `reference_id` text NOT NULL,
  `stripe_customer_id` text,
  `stripe_subscription_id` text,
  `status` text NOT NULL,
  `period_start` integer,
  `period_end` integer,
  `cancel_at_period_end` integer,
  `cancel_at` integer,
  `canceled_at` integer,
  `ended_at` integer,
  `seats` integer,
  `trial_start` integer,
  `trial_end` integer,
  `billing_interval` text,
  `stripe_schedule_id` text,
  `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
CREATE INDEX `subscription_reference_idx` ON `subscription` (`reference_id`);
```

Match the exact SQL dialect/quoting style of `migrations/0003_phase7-sex-apikeys.sql` — open it and compare before writing.

- [ ] **Step 3: Apply locally and run tests**

Run: `pnpm db:migrate:local && pnpm test`
Expected: migration applies cleanly; full suite PASS (tests auto-apply migrations via `readD1Migrations`).

- [ ] **Step 4: Commit**

```bash
git add src/worker/db/auth-schema.ts migrations/0007_phase9-billing.sql
git commit -m "feat(billing): subscription table + stripe customer id columns" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Entitlements + plan transition helpers (TDD)

**Files:**
- Modify: `src/worker/entitlements.ts`
- Create: `src/worker/billing.ts`
- Test: `test/billing.test.ts`

**Interfaces:**
- Produces (from `entitlements.ts`):
  `type Feature = "growthCharts" | "apiKeys" | "csvExport" | "statsMonth"`;
  `canUse(family: { plan: string }, feature: Feature): boolean`.
- Produces (from `billing.ts`):
  `applySubscriptionStatus(db: Db, familyId: string, status: string): Promise<void>`;
  `grantLifetime(db: Db, familyId: string): Promise<void>`;
  `PREMIUM_STATUSES: ReadonlySet<string>` (statuses `"active"` and `"trialing"`).
- Consumes: `schema.organization` from Task 2's schema, `Db` type from `src/worker/db`.

- [ ] **Step 1: Write failing tests in `test/billing.test.ts`**

Use the existing helper conventions (`test/helpers.ts`: `db`, `createFamily`; look at `test/tenancy.test.ts` for describe/it structure). Read a family's plan with:

```ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { canUse } from "../src/worker/entitlements";
import { applySubscriptionStatus, grantLifetime } from "../src/worker/billing";
import { db, createFamily } from "./helpers";
import { schema } from "../src/worker/db";

const planOf = async (id: string) =>
  (
    await db()
      .select({ plan: schema.organization.plan })
      .from(schema.organization)
      .where(eq(schema.organization.id, id))
  )[0]!.plan;

const setPlan = (id: string, plan: string) =>
  db()
    .update(schema.organization)
    .set({ plan })
    .where(eq(schema.organization.id, id));

describe("canUse", () => {
  it("denies premium features on free, allows on every paid plan", () => {
    for (const feature of ["growthCharts", "apiKeys", "csvExport", "statsMonth"] as const) {
      expect(canUse({ plan: "free" }, feature)).toBe(false);
      expect(canUse({ plan: "premium" }, feature)).toBe(true);
      expect(canUse({ plan: "lifetime" }, feature)).toBe(true);
      expect(canUse({ plan: "comp" }, feature)).toBe(true);
    }
  });
});

describe("plan transitions", () => {
  it("active subscription upgrades free -> premium", async () => {
    const fam = await createFamily("Sub family");
    await applySubscriptionStatus(db(), fam.id, "active");
    expect(await planOf(fam.id)).toBe("premium");
  });

  it("canceled subscription downgrades premium -> free", async () => {
    const fam = await createFamily("Cancel family");
    await setPlan(fam.id, "premium");
    await applySubscriptionStatus(db(), fam.id, "canceled");
    expect(await planOf(fam.id)).toBe("free");
  });

  it("subscription events never clobber lifetime or comp", async () => {
    for (const shielded of ["lifetime", "comp"]) {
      const fam = await createFamily(`Shielded ${shielded}`);
      await setPlan(fam.id, shielded);
      await applySubscriptionStatus(db(), fam.id, "canceled");
      expect(await planOf(fam.id)).toBe(shielded);
      await applySubscriptionStatus(db(), fam.id, "active");
      expect(await planOf(fam.id)).toBe(shielded);
    }
  });

  it("grantLifetime sets lifetime and is idempotent", async () => {
    const fam = await createFamily("Lifetime family");
    await grantLifetime(db(), fam.id);
    expect(await planOf(fam.id)).toBe("lifetime");
    await grantLifetime(db(), fam.id);
    expect(await planOf(fam.id)).toBe("lifetime");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/billing.test.ts`
Expected: FAIL — `canUse` rejects the new Feature values (type error) / `billing.ts` module missing.

- [ ] **Step 3: Implement `src/worker/entitlements.ts`**

Replace the file body with:

```ts
// Central entitlement gate. Every feature gate routes through this.
// The map exists so a future plan matrix is a data change, not a refactor.
export type Feature = "growthCharts" | "apiKeys" | "csvExport" | "statsMonth";

const requiresPremium: Record<Feature, boolean> = {
  growthCharts: true,
  apiKeys: true,
  csvExport: true,
  statsMonth: true,
};

export function canUse(family: { plan: string }, feature: Feature): boolean {
  if (!requiresPremium[feature]) return true;
  return family.plan !== "free";
}
```

- [ ] **Step 4: Implement `src/worker/billing.ts`**

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";

// Stripe subscription statuses that grant Premium. Everything else (canceled,
// incomplete_expired, past_due, unpaid, …) means the family is not paying.
export const PREMIUM_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
]);

// The invariant both directions share: subscription events may only ever
// move a family between "free" and "premium" — lifetime and comp are set
// through other paths and must never be touched by webhook traffic.
export async function applySubscriptionStatus(
  db: Db,
  familyId: string,
  status: string,
): Promise<void> {
  if (PREMIUM_STATUSES.has(status)) {
    await db
      .update(schema.organization)
      .set({ plan: "premium" })
      .where(
        and(
          eq(schema.organization.id, familyId),
          eq(schema.organization.plan, "free"),
        ),
      );
  } else {
    await db
      .update(schema.organization)
      .set({ plan: "free" })
      .where(
        and(
          eq(schema.organization.id, familyId),
          eq(schema.organization.plan, "premium"),
        ),
      );
  }
}

export async function grantLifetime(db: Db, familyId: string): Promise<void> {
  await db
    .update(schema.organization)
    .set({ plan: "lifetime" })
    .where(
      and(
        eq(schema.organization.id, familyId),
        inArray(schema.organization.plan, ["free", "premium"]),
      ),
    );
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/billing.test.ts`
Expected: PASS. Then `pnpm check` (type surface changed) — expected PASS since nothing calls `canUse` with `"core"` (verified: zero call sites).

- [ ] **Step 6: Commit**

```bash
git add src/worker/entitlements.ts src/worker/billing.ts test/billing.test.ts
git commit -m "feat(billing): entitlement features + plan transition helpers" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: better-auth Stripe plugin wiring

**Files:**
- Modify: `src/worker/auth.ts`
- Test: `test/billing.test.ts` (append)

**Interfaces:**
- Consumes: `createStripe(env)` (Task 1), `applySubscriptionStatus`, `grantLifetime` (Task 3).
- Produces: the plugin's routes under `/api/auth/subscription/*` and `/api/auth/stripe/webhook`, already reachable through the existing `app.on(["GET","POST"], "/api/auth/*", …)` mount — no `index.ts` change.

- [ ] **Step 1: Write the failing plumbing test (append to `test/billing.test.ts`)**

```ts
import { SELF } from "cloudflare:test";

describe("stripe webhook plumbing", () => {
  it("webhook endpoint exists and rejects an unsigned payload", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    // 400/401 = signature verification ran (plugin mounted). 404 = not wired.
    expect([400, 401]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/billing.test.ts`
Expected: FAIL with 404 (plugin not mounted yet).

- [ ] **Step 3: Wire the plugin in `src/worker/auth.ts`**

Add imports:

```ts
import { stripe } from "@better-auth/stripe";
import type Stripe from "stripe";
import { createStripe } from "./stripe";
import { applySubscriptionStatus, grantLifetime } from "./billing";
```

Inside `createAuth`, before the `return betterAuth({…})`, create the client and a tiny helper:

```ts
const stripeClient = createStripe(env);
```

Append to the `plugins` array (after `admin()`):

```ts
// Billing (Phase 9): org-level subscriptions AND org-level Stripe
// customers — the family owns both the entitlement and the customer.
// organization.plan is the denormalized gate the app reads; these hooks
// are the only writers besides the lifetime webhook + sysadmin override.
stripe({
  stripeClient,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  organization: { enabled: true },
  subscription: {
    enabled: true,
    plans: [
      {
        name: "premium",
        priceId: env.STRIPE_PRICE_PREMIUM_MONTHLY,
        annualDiscountPriceId: env.STRIPE_PRICE_PREMIUM_YEARLY,
      },
    ],
    // Only family admins may buy/cancel/restore/list for a family.
    authorizeReference: async ({ user, referenceId }) => {
      const rows = await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, referenceId),
            eq(schema.member.userId, user.id),
          ),
        )
        .limit(1);
      const role = rows[0]?.role;
      return role === "admin" || role === "owner";
    },
    onSubscriptionComplete: async ({ subscription }) => {
      await applySubscriptionStatus(db, subscription.referenceId, "active");
    },
    onSubscriptionUpdate: async ({ subscription }) => {
      await applySubscriptionStatus(
        db,
        subscription.referenceId,
        subscription.status,
      );
    },
    onSubscriptionCancel: async ({ subscription }) => {
      // Fires when cancellation is SCHEDULED (cancel_at_period_end) as well
      // as when it lands; applySubscriptionStatus keys off status, so a
      // still-active-until-period-end sub stays premium.
      await applySubscriptionStatus(
        db,
        subscription.referenceId,
        subscription.status,
      );
    },
    onSubscriptionDeleted: async ({ subscription }) => {
      await applySubscriptionStatus(db, subscription.referenceId, "canceled");
    },
    getCheckoutSessionParams: async () => ({
      params: { automatic_tax: { enabled: true } },
    }),
  },
  // Lifetime (one-time payment) rides the same webhook.
  onEvent: async (event) => {
    if (event.type !== "checkout.session.completed") return;
    const session = event.data.object as Stripe.Checkout.Session;
    if (
      session.mode === "payment" &&
      session.payment_status === "paid" &&
      session.metadata?.kind === "lifetime" &&
      session.metadata.familyId
    ) {
      await grantLifetime(db, session.metadata.familyId);
    }
  },
}),
```

Adjust to the actual option/hook names in the installed plugin's TypeScript types — the names above are from the docs; if e.g. `onSubscriptionDeleted` doesn't exist in 1.7.x, rely on `onSubscriptionUpdate` + `onEvent`'s `customer.subscription.deleted` instead. Whatever the types say wins. `and` is already imported? — `auth.ts` currently imports only `eq` from drizzle-orm; extend to `{ and, eq }`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/billing.test.ts && pnpm check`
Expected: PASS. The webhook test now gets 400/401 (signature rejected — proves `constructEventAsync` path works under nodejs_compat; this is the spike gate from the spec). If it throws a runtime error about synchronous crypto instead, STOP and record the failure — fallback per spec is hand-rolling the webhook route.

- [ ] **Step 5: Run the full suite (auth surface changed)**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/auth.ts test/billing.test.ts
git commit -m "feat(billing): wire @better-auth/stripe plugin with org-level premium plan" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Server gates (TDD)

**Files:**
- Modify: `src/worker/context.ts` (FamEnv gains `plan: string`)
- Modify: `src/worker/middleware/tenancy.ts` (requireFamily loads plan)
- Modify: `src/worker/middleware/api-key.ts` (keys stop working on free)
- Modify: `src/worker/routes/keys.ts` (create gated)
- Modify: `src/worker/routes/export.ts` (gated)
- Modify: `src/worker/routes/stats.ts` (days>7 gated)
- Test: `test/billing.test.ts` (append)

**Interfaces:**
- Consumes: `canUse` (Task 3).
- Produces: `c.var.plan: string` available after `requireFamily`; gate error shape `{ error: "Premium required", code: "PLAN_REQUIRED" }` status 402.

- [ ] **Step 1: Write failing gate tests (append to `test/billing.test.ts`)**

Use `rig()` + `setPlan` (from Task 3's test file) + the `api` helper:

```ts
import { api, rig } from "./helpers";

describe("premium gates", () => {
  it("POST /api/keys is 402 on free, 201 on premium", async () => {
    const { family, cookie } = await rig();
    const denied = await api("/api/keys", {
      method: "POST",
      cookie,
      body: { name: "ha", readOnly: true },
    });
    expect(denied.status).toBe(402);
    expect((await denied.json()).code).toBe("PLAN_REQUIRED");

    await setPlan(family.id, "premium");
    const ok = await api("/api/keys", {
      method: "POST",
      cookie,
      body: { name: "ha", readOnly: true },
    });
    expect(ok.status).toBe(201);
  });

  it("GET /api/export.csv is 402 on free, 200 on comp", async () => {
    const { family, cookie } = await rig();
    expect((await api("/api/export.csv", { cookie })).status).toBe(402);
    await setPlan(family.id, "comp");
    expect((await api("/api/export.csv", { cookie })).status).toBe(200);
  });

  it("stats month view is 402 on free, week stays free", async () => {
    const { family, baby, cookie } = await rig();
    const week = await api(`/api/stats?babyId=${baby.id}&days=7`, { cookie });
    expect(week.status).toBe(200);
    const month = await api(`/api/stats?babyId=${baby.id}&days=30`, { cookie });
    expect(month.status).toBe(402);
    await setPlan(family.id, "lifetime");
    const paid = await api(`/api/stats?babyId=${baby.id}&days=30`, { cookie });
    expect(paid.status).toBe(200);
  });

  it("existing API keys stop authenticating on free (soft lock)", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");
    const created = await api("/api/keys", {
      method: "POST",
      cookie,
      body: { name: "ha", readOnly: true },
    });
    const { key } = (await created.json()) as { key: string };

    const useKey = (k: string) =>
      SELF.fetch("http://localhost/api/babies", {
        headers: { authorization: `Bearer ${k}`, origin: "http://localhost" },
      });

    expect((await useKey(key)).status).toBe(200);
    await setPlan(family.id, "free");
    const locked = await useKey(key);
    expect(locked.status).toBe(402);
    expect(((await locked.json()) as { code: string }).code).toBe("PLAN_REQUIRED");
    await setPlan(family.id, "premium");
    expect((await useKey(key)).status).toBe(200);
  });
});
```

(Check `test/api-keys.test.ts` for the actual create-key body fields and the exact endpoint a key can GET — mirror those. `SELF` is already imported for the webhook test.)

- [ ] **Step 2: Run to verify failures**

Run: `pnpm vitest run test/billing.test.ts`
Expected: the four new tests FAIL (endpoints return 200/201 where 402 is expected — nothing is gated yet). NOTE: the first assertions (`402` expected) fail while later `premium` assertions would pass — that's the point.

- [ ] **Step 3: Load plan in `requireFamily` + type it**

`src/worker/context.ts` — in `FamEnv["Variables"]` add:

```ts
plan: string;
```

`src/worker/middleware/tenancy.ts` — change the membership query to join the organization so role + plan come back in one D1 read:

```ts
const membership = await c.var.db
  .select({ role: schema.member.role, plan: schema.organization.plan })
  .from(schema.member)
  .innerJoin(
    schema.organization,
    eq(schema.member.organizationId, schema.organization.id),
  )
  .where(
    and(
      eq(schema.member.organizationId, familyId),
      eq(schema.member.userId, session.user.id),
    ),
  )
  .limit(1);
```

and after `c.set("memberRole", …)` add:

```ts
c.set("plan", membership[0].plan);
```

- [ ] **Step 4: Gate key creation (`src/worker/routes/keys.ts`)**

Add to imports: `import { canUse } from "../entitlements";` and add a 402 response to the `createKey` route:

```ts
402: jsonContent(ErrorSchema, "Premium required"),
```

At the top of the create handler:

```ts
if (!canUse({ plan: c.var.plan }, "apiKeys")) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

(List + revoke stay ungated — a downgraded family can still see and revoke its keys.)

- [ ] **Step 5: Gate CSV export (`src/worker/routes/export.ts`)**

At the top of the handler:

```ts
import { canUse } from "../entitlements";
// …
if (!canUse({ plan: c.var.plan }, "csvExport")) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

- [ ] **Step 6: Gate stats month (`src/worker/routes/stats.ts`)**

Add `402: jsonContent(ErrorSchema, "Premium required")` to the route's responses. In the handler, right after `const q = c.req.valid("query");`:

```ts
if (q.days > 7 && !canUse({ plan: c.var.plan }, "statsMonth")) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

- [ ] **Step 7: Soft-lock key consumption (`src/worker/middleware/api-key.ts`)**

Join the organization in the existing key lookup select — add to the `.select({…})`:

```ts
plan: schema.organization.plan,
```

and after the existing `.innerJoin(schema.user, …)` add:

```ts
.innerJoin(
  schema.organization,
  eq(schema.apiKey.familyId, schema.organization.id),
)
```

Then after the expiry check:

```ts
// Soft lock: API keys are a Premium feature. Keys survive a downgrade in
// the DB but stop authenticating until the family pays again.
if (!canUse({ plan: row.plan }, "apiKeys")) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

with `import { canUse } from "../entitlements";`.

- [ ] **Step 8: Run gate tests, then the full suite**

Run: `pnpm vitest run test/billing.test.ts`
Expected: PASS.
Run: `pnpm test && pnpm check`
Expected: PASS — EXCEPT existing tests that exercise API keys / export / stats-month on a default-free family will now hit 402. Fix those tests by setting the rig family's plan to `premium` in their setup (e.g. `test/api-keys.test.ts`, possibly `test/stats.test.ts`, `test/security.test.ts`). Do NOT weaken the gates to keep old tests green — update the tests; this is the intended behavior change.

- [ ] **Step 9: Commit**

```bash
git add src/worker/context.ts src/worker/middleware/tenancy.ts src/worker/middleware/api-key.ts src/worker/routes/keys.ts src/worker/routes/export.ts src/worker/routes/stats.ts test/
git commit -m "feat(billing): premium gates — keys, csv export, stats month, key soft-lock" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Lifetime checkout route

**Files:**
- Create: `src/worker/routes/billing.ts`
- Modify: `src/worker/index.ts` (mount + requireAdmin)
- Modify: `src/shared/schemas.ts` (CheckoutUrlSchema)
- Test: `test/billing.test.ts` (append)

**Interfaces:**
- Consumes: `createStripe(env)` (Task 1), `c.var.plan` (Task 5), `ErrorSchema`/`jsonContent`/`createApp` (existing).
- Produces: `POST /api/billing/lifetime` → 200 `{ url: string }` | 409 `ALREADY_PREMIUM`; exported `billingApp` (FamEnv). `CheckoutUrlSchema = z.object({ url: z.string() }).openapi("CheckoutUrl")` in shared schemas.

- [ ] **Step 1: Write failing tests (append to `test/billing.test.ts`)**

```ts
describe("lifetime checkout", () => {
  it("rejects members (admin-only)", async () => {
    const { family } = await rig();
    const member = await createUser("Member");
    await addMember(member.id, family.id, "member");
    const cookie = await signIn(member.email);
    const res = await api("/api/billing/lifetime", { method: "POST", cookie });
    expect(res.status).toBe(403);
  });

  it("rejects an already-paying family", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "premium");
    const res = await api("/api/billing/lifetime", { method: "POST", cookie });
    expect(res.status).toBe(409);
  });
});
```

(Import `addMember, createUser, signIn` from `./helpers`.) The happy path calls Stripe's network API and is covered by manual test-mode smoke testing, not unit tests.

- [ ] **Step 2: Run to verify 404s**

Run: `pnpm vitest run test/billing.test.ts`
Expected: FAIL — 404, route doesn't exist.

- [ ] **Step 3: Add `CheckoutUrlSchema` to `src/shared/schemas.ts`**

Near `FamilySchema`:

```ts
export const CheckoutUrlSchema = z
  .object({ url: z.string() })
  .openapi("CheckoutUrl");
```

- [ ] **Step 4: Implement `src/worker/routes/billing.ts`**

```ts
import { createRoute } from "@hono/zod-openapi";
import { CheckoutUrlSchema, ErrorSchema } from "@shared/schemas";
import type { FamEnv } from "../context";
import { createApp, jsonContent } from "../lib";
import { createStripe } from "../stripe";

// The lifetime plan is a one-time payment, which the better-auth stripe
// plugin doesn't model — this route creates the Checkout Session itself and
// the plugin's onEvent handler (auth.ts) grants the plan when the session
// completes. Subscriptions never touch this route.
const lifetimeCheckout = createRoute({
  method: "post",
  path: "/api/billing/lifetime",
  tags: ["billing"],
  description:
    "Create a Stripe Checkout session for the one-time lifetime Premium purchase. Admin only. Redirect the browser to the returned url.",
  responses: {
    200: jsonContent(CheckoutUrlSchema, "Checkout session created"),
    409: jsonContent(ErrorSchema, "Family already has Premium"),
  },
});

export const billingApp = createApp<FamEnv>().openapi(
  lifetimeCheckout,
  async (c) => {
    if (c.var.plan !== "free") {
      return c.json(
        { error: "Family already has Premium", code: "ALREADY_PREMIUM" },
        409,
      );
    }
    const stripe = createStripe(c.env);
    const family = await c.var.fam.family();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: c.env.STRIPE_PRICE_PREMIUM_LIFETIME, quantity: 1 }],
      client_reference_id: c.var.familyId,
      metadata: { kind: "lifetime", familyId: c.var.familyId },
      customer_email: c.var.sessionData.user.email,
      automatic_tax: { enabled: true },
      success_url: `${c.env.APP_URL}/settings?billing=success`,
      cancel_url: `${c.env.APP_URL}/settings?billing=canceled`,
    });
    if (!session.url) {
      return c.json(
        { error: "Stripe did not return a checkout URL", code: "STRIPE_ERROR" },
        409,
      );
    }
    return c.json({ url: session.url }, 200);
  },
);
```

Note: if the org already has a `stripeCustomerId` (set by a prior subscription), prefer `customer: family.stripeCustomerId` over `customer_email` — requires adding `stripeCustomerId` to the `fam.family()` select in `src/worker/db/scoped.ts` (add the column to the select; do NOT add it to `FamilySchema`). If that's more than a 5-line change, keep `customer_email` and note it in DECISIONS.md.

- [ ] **Step 5: Mount in `src/worker/index.ts`**

Import `billingApp` from `./routes/billing`. Add middleware lines next to the keys ones:

```ts
domainBase.use("/api/billing/*", requireAdmin);
```

and add `.route("/", billingApp)` to the `domainApp` chain (after `keysApp`).

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run test/billing.test.ts && pnpm check`
Expected: PASS (403 member / 409 premium paths; the free-admin path would call Stripe and is not unit-tested).

- [ ] **Step 7: Commit**

```bash
git add src/worker/routes/billing.ts src/worker/index.ts src/shared/schemas.ts test/billing.test.ts
git commit -m "feat(billing): lifetime one-time checkout route" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Admin plan override + family-delete subscription cancel

**Files:**
- Modify: `src/worker/routes/admin.ts`
- Modify: `src/shared/schemas.ts` (AdminSetPlanSchema)
- Modify: `src/web/screens/admin/Families.tsx`
- Test: `test/billing.test.ts` (append)

**Interfaces:**
- Consumes: `audit(db, adminId, action, target, detail?)` from `middleware/sysadmin`, `schema.subscription` (Task 2), `createStripe` (Task 1).
- Produces: `POST /api/admin/families/{id}/plan` body `{ plan: "free" | "comp" }` → `{ ok: true }`; `AdminSetPlanSchema = z.object({ plan: z.enum(["free", "comp"]) }).openapi("AdminSetPlan")`.

- [ ] **Step 1: Write failing tests (append to `test/billing.test.ts`)**

Look at `test/admin.test.ts` for how a sysadmin user is created (role "admin" on the user row) and reuse its pattern:

```ts
describe("admin plan override", () => {
  async function sysadmin() {
    const u = await createUser("Sys");
    await db()
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, u.id));
    return signIn(u.email);
  }

  it("sets comp and back to free, audited; rejects premium/lifetime values", async () => {
    const cookie = await sysadmin();
    const fam = await createFamily("Comp family");

    const comp = await api(`/api/admin/families/${fam.id}/plan`, {
      method: "POST",
      cookie,
      body: { plan: "comp" },
    });
    expect(comp.status).toBe(200);
    expect(await planOf(fam.id)).toBe("comp");

    const bad = await api(`/api/admin/families/${fam.id}/plan`, {
      method: "POST",
      cookie,
      body: { plan: "premium" },
    });
    expect(bad.status).toBe(400);

    const back = await api(`/api/admin/families/${fam.id}/plan`, {
      method: "POST",
      cookie,
      body: { plan: "free" },
    });
    expect(back.status).toBe(200);
    expect(await planOf(fam.id)).toBe("free");

    const trail = await db()
      .select()
      .from(schema.adminAudit)
      .where(eq(schema.adminAudit.action, "billing.plan.set"));
    expect(trail.length).toBe(2);
  });

  it("is sysadmin-only", async () => {
    const { cookie } = await rig(); // family admin, NOT sysadmin
    const fam = await createFamily("Other family");
    const res = await api(`/api/admin/families/${fam.id}/plan`, {
      method: "POST",
      cookie,
      body: { plan: "comp" },
    });
    expect([401, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/billing.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Add `AdminSetPlanSchema` to `src/shared/schemas.ts`**

Next to `AdminFamilySchema`:

```ts
export const AdminSetPlanSchema = z
  .object({ plan: z.enum(["free", "comp"]) })
  .openapi("AdminSetPlan");
```

(The zod enum makes `premium`/`lifetime` a 400 VALIDATION error automatically.)

- [ ] **Step 4: Add the route to `src/worker/routes/admin.ts`**

Route definition (near `deleteFamily`):

```ts
const setFamilyPlan = createRoute({
  method: "post",
  path: "/api/admin/families/{id}/plan",
  tags: ["admin"],
  description:
    "Support override for a family's plan. Only 'free' and 'comp' — Stripe-derived values (premium/lifetime) are written exclusively by webhooks. Audited.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AdminSetPlanSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ ok: z.literal(true) }), "Plan set"),
    404: jsonContent(ErrorSchema, "Not found"),
  },
});
```

Handler (chained with the others):

```ts
.openapi(setFamilyPlan, async (c) => {
  const { id } = c.req.valid("param");
  const { plan } = c.req.valid("json");
  const db = c.var.db;
  const org = await db
    .select({ plan: schema.organization.plan })
    .from(schema.organization)
    .where(eq(schema.organization.id, id));
  if (!org[0]) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  }
  await audit(
    db,
    c.var.sessionData!.user.id,
    "billing.plan.set",
    id,
    `${org[0].plan} -> ${plan}`,
  );
  await db
    .update(schema.organization)
    .set({ plan })
    .where(eq(schema.organization.id, id));
  return c.json({ ok: true as const }, 200);
})
```

Import `AdminSetPlanSchema` in the schemas import.

- [ ] **Step 5: Cancel subscriptions in the family-delete handler**

In the existing `deleteFamily` handler, after the audit call and before `db.delete(schema.organization)`:

```ts
// Billing can't outlive the data: cancel any live Stripe subscription
// before the cascade delete. Best-effort — a Stripe hiccup shouldn't
// block the delete (the sub would be orphaned either way).
const subs = await db
  .select({ stripeSubscriptionId: schema.subscription.stripeSubscriptionId })
  .from(schema.subscription)
  .where(eq(schema.subscription.referenceId, id));
const stripeClient = createStripe(c.env);
for (const s of subs) {
  if (s.stripeSubscriptionId) {
    await stripeClient.subscriptions
      .cancel(s.stripeSubscriptionId)
      .catch(() => {});
  }
}
await db.delete(schema.subscription).where(eq(schema.subscription.referenceId, id));
```

Import `createStripe` from `../stripe`. (The subscription table has no FK to organization, so the explicit delete keeps it tidy.)

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run test/billing.test.ts && pnpm test`
Expected: PASS (family delete tests still pass — cancel loop is a no-op with no subscription rows).

- [ ] **Step 7: Add the override control to `src/web/screens/admin/Families.tsx`**

Add a mutation + a compact control next to the plan badge. Only offer the two legal values; show the current plan as the badge already does:

```tsx
const setPlan = useMutation({
  mutationFn: async (vars: { id: string; plan: "free" | "comp" }) =>
    unwrap(
      await api.admin.families[":id"].plan.$post({
        param: { id: vars.id },
        json: { plan: vars.plan },
      }),
    ),
  onSuccess: () => {
    toast("Plan updated");
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  },
  onError: (err) => toast(err.message, "error"),
});
```

In the row, next to `DeleteButton` (admin console is English-only, no `t()` — match the existing file):

```tsx
{f.plan === "comp" ? (
  <button
    type="button"
    className="text-xs font-semibold text-muted underline"
    onClick={() => setPlan.mutate({ id: f.id, plan: "free" })}
  >
    Revoke comp
  </button>
) : f.plan === "free" ? (
  <button
    type="button"
    className="text-xs font-semibold text-muted underline"
    onClick={() => setPlan.mutate({ id: f.id, plan: "comp" })}
  >
    Comp
  </button>
) : null}
```

(Paying plans — premium/lifetime — get no override control, matching the endpoint's rules.)

- [ ] **Step 8: Verify + commit**

Run: `pnpm check && pnpm test`
Expected: PASS.

```bash
git add src/worker/routes/admin.ts src/shared/schemas.ts src/web/screens/admin/Families.tsx test/billing.test.ts
git commit -m "feat(admin): audited family plan override + subscription cancel on family delete" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Client billing — auth client plugin, useFamily, BillingSection

**Files:**
- Modify: `src/web/lib/auth-client.ts`
- Modify: `src/web/lib/data/family.ts` (+ re-export in `src/web/lib/data/index.ts`)
- Create: `src/web/screens/settings/BillingSection.tsx`
- Modify: `src/web/screens/settings/index.tsx`
- Modify: `src/web/lib/i18n.ts` (nb entries)

**Interfaces:**
- Consumes: `GET /api/family` (existing, returns `{ id, name, slug, plan }`), `POST /api/billing/lifetime` (Task 6), `authClient.subscription.upgrade` / billing-portal method (Task 4 plugin).
- Produces: `useFamily(): UseQueryResult<Family>` with `queryKey: ["family"]`; `<BillingSection isAdmin={boolean} />` rendering a `Card` with `id="billing"`.

- [ ] **Step 1: Add the stripe client plugin to `src/web/lib/auth-client.ts`**

```ts
import { stripeClient } from "@better-auth/stripe/client";
// …
plugins: [organizationClient(), adminClient(), stripeClient({ subscription: true })],
```

- [ ] **Step 2: Add `useFamily` to `src/web/lib/data/family.ts`**

```ts
import type { Baby, Family, Invite, Member } from "@shared/schemas";
// (add `Family` to the existing type import; if `Family` isn't exported as a
// type from @shared/schemas, add `export type Family = z.infer<typeof FamilySchema>;`
// there next to the schema.)

export function useFamily() {
  return useQuery({
    queryKey: ["family"],
    queryFn: async () => unwrap<Family>(await api.family.$get()),
  });
}
```

Re-export from `src/web/lib/data/index.ts` alongside `useMembers` (match the file's existing re-export style).

- [ ] **Step 3: Create `src/web/screens/settings/BillingSection.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useFamily } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  premium: "Premium",
  lifetime: "Premium · lifetime",
  comp: "Premium · complimentary",
};

export function BillingSection({ isAdmin }: { isAdmin: boolean }) {
  const family = useFamily();
  const queryClient = useQueryClient();
  const plan = family.data?.plan ?? "free";
  const handled = useRef(false);

  // Checkout return: the webhook can lag the redirect, so poll briefly
  // until the plan flips before celebrating.
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("billing");
    if (!outcome) return;
    handled.current = true;
    params.delete("billing");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
    if (outcome !== "success") return;
    toast(t("Payment received — welcome to Premium!"));
    let tries = 0;
    const tick = () => {
      void queryClient
        .invalidateQueries({ queryKey: ["family"] })
        .then(() => {
          tries += 1;
          const current = queryClient.getQueryData<{ plan: string }>(["family"]);
          if ((current?.plan ?? "free") === "free" && tries < 5) {
            setTimeout(tick, 2000);
          }
        });
    };
    tick();
  }, [queryClient]);

  const subscribe = async (annual: boolean) => {
    if (!family.data) return;
    const { error } = await authClient.subscription.upgrade({
      plan: "premium",
      annual,
      referenceId: family.data.id,
      customerType: "organization",
      successUrl: "/settings?billing=success",
      cancelUrl: "/settings?billing=canceled",
    });
    if (error) toast(error.message ?? t("Something went wrong"), "error");
  };

  const buyLifetime = async () => {
    try {
      const { url } = await unwrap<{ url: string }>(
        await api.billing.lifetime.$post(),
      );
      window.location.assign(url);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const manage = async () => {
    if (!family.data) return;
    const { error } = await authClient.subscription.billingPortal({
      referenceId: family.data.id,
      customerType: "organization",
      returnUrl: "/settings",
    });
    if (error) toast(error.message ?? t("Something went wrong"), "error");
  };

  return (
    <>
      <SectionTitle>{t("Plan")}</SectionTitle>
      <Card id="billing" className="space-y-3">
        <p className="text-sm text-ink-soft">
          {t("Current plan")}
          <span className="block text-base font-bold text-ink">
            {t(PLAN_LABEL[plan] ?? plan)}
          </span>
        </p>

        {plan === "free" && (
          <>
            <p className="text-sm text-muted">
              {t(
                "Premium unlocks growth charts, month stats, CSV export and API keys.",
              )}
            </p>
            {isAdmin ? (
              <div className="space-y-2">
                <Button size="full" onClick={() => void subscribe(false)}>
                  {t("Premium monthly — 20 kr/mo")}
                </Button>
                <Button
                  size="full"
                  variant="outline"
                  onClick={() => void subscribe(true)}
                >
                  {t("Premium yearly — 200 kr/yr")}
                </Button>
                <Button size="full" variant="outline" onClick={() => void buyLifetime()}>
                  {t("Lifetime — 400 kr once")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted">
                {t("Ask a family admin to upgrade.")}
              </p>
            )}
          </>
        )}

        {plan === "premium" && isAdmin && (
          <Button size="full" variant="outline" onClick={() => void manage()}>
            {t("Manage subscription")}
          </Button>
        )}
      </Card>
    </>
  );
}
```

Verify the portal method name against the installed plugin's client types (`authClient.subscription.billingPortal` vs a top-level `authClient.billingPortal` — docs show both spellings; use what the types expose). Verify `Card` forwards `id`/HTML props; if not, wrap in a `<div id="billing">`.

- [ ] **Step 4: Wire into `src/web/screens/settings/index.tsx`**

Import `BillingSection` and `useFamily`. Render between `<AppearanceSection />` and the API keys block:

```tsx
<BillingSection isAdmin={isAdmin} />
```

Gate CSV: derive `const premium = (useFamily().data?.plan ?? "free") !== "free";` (call `useFamily()` once at the top of the component). Replace the CSV button's onClick:

```tsx
onClick={() =>
  premium
    ? window.location.assign(`${API_BASE}/api/export.csv`)
    : document.getElementById("billing")?.scrollIntoView({ behavior: "smooth" })
}
```

and when `!premium` render the button label as `{t("Export CSV")} · {t("Premium")}` with `variant="outline"` — keep it simple, one button, different behavior.

Gate the API keys section the same way: change the condition `{isAdmin && (…)}` to `{isAdmin && premium && (…)}` and add, for `isAdmin && !premium`:

```tsx
<>
  <SectionTitle>{t("API keys")}</SectionTitle>
  <Card>
    <p className="text-sm text-muted">{t("API keys are a Premium feature.")}</p>
  </Card>
</>
```

- [ ] **Step 5: Add `nb` i18n entries**

In `src/web/lib/i18n.ts`, add a `// Billing` comment group with Norwegian translations for every new `t()` string used above, e.g.:

```ts
// Billing
"Plan": "Abonnement",
"Current plan": "Gjeldende plan",
"Free": "Gratis",
"Premium": "Premium",
"Premium · lifetime": "Premium · livstid",
"Premium · complimentary": "Premium · sponset",
"Premium unlocks growth charts, month stats, CSV export and API keys.":
  "Premium låser opp vekstkurver, månedsstatistikk, CSV-eksport og API-nøkler.",
"Premium monthly — 20 kr/mo": "Premium månedlig — 20 kr/mnd",
"Premium yearly — 200 kr/yr": "Premium årlig — 200 kr/år",
"Lifetime — 400 kr once": "Livstid — 400 kr én gang",
"Ask a family admin to upgrade.": "Be en familieadministrator om å oppgradere.",
"Manage subscription": "Administrer abonnement",
"Payment received — welcome to Premium!": "Betaling mottatt — velkommen til Premium!",
"Something went wrong": "Noe gikk galt",
"API keys are a Premium feature.": "API-nøkler er en Premium-funksjon.",
```

Cross-check the FINAL list of `t()` literals against the code you actually wrote — `pnpm check` runs `scripts/check-i18n.mjs` and will list any missing key.

- [ ] **Step 6: Verify**

Run: `pnpm check && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/lib/auth-client.ts src/web/lib/data/ src/web/screens/settings/ src/web/lib/i18n.ts
git commit -m "feat(billing): settings billing section, useFamily hook, csv/api-keys gating" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Client gates on Stats (growth chart + month view)

**Files:**
- Modify: `src/web/screens/Stats.tsx`
- Modify: `src/web/lib/i18n.ts`

**Interfaces:**
- Consumes: `useFamily` (Task 8).

- [ ] **Step 1: Gate the month toggle and growth chart in `StatsScreen`**

Add at the top of `StatsScreen`:

```tsx
const family = useFamily();
const navigate = useNavigate();
const premium = (family.data?.plan ?? "free") !== "free";
```

(`useNavigate` from `@tanstack/react-router`; `useFamily` from `@/lib/data`.)

Change the ChipGroup's `onChange`:

```tsx
onChange={(v) => {
  if (v === "30" && !premium) {
    toast(t("Month view is a Premium feature"));
    void navigate({ to: "/settings" });
    return;
  }
  setDays(Number(v) as 7 | 30);
}}
```

(`toast` from `@/lib/toast` — check the import path used elsewhere in screens.)

Replace the growth chart line:

```tsx
{baby &&
  (premium ? (
    <GrowthChart baby={baby} />
  ) : (
    <Card className="flex items-center gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
        <IconLock className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{t("Growth chart")}</p>
        <p className="text-xs text-muted">
          {t("WHO percentile curves are a Premium feature.")}{" "}
          <Link to="/settings" className="underline">
            {t("Upgrade")}
          </Link>
        </p>
      </div>
    </Card>
  ))}
```

Imports: `IconLock` from `@tabler/icons-react`, `Link` from `@tanstack/react-router` (check whether Stats.tsx already imports them).

Also guard the state itself: if `days === 30 && !premium` (e.g. persisted query cache from before a downgrade), the `useStats(baby?.id, days)` query would 402. Add:

```tsx
useEffect(() => {
  if (days === 30 && family.isSuccess && !premium) setDays(7);
}, [days, premium, family.isSuccess]);
```

- [ ] **Step 2: Add nb entries**

```ts
"Month view is a Premium feature": "Månedsvisning er en Premium-funksjon",
"Growth chart": "Vekstkurve",
"WHO percentile curves are a Premium feature.": "WHO-percentilkurver er en Premium-funksjon.",
"Upgrade": "Oppgrader",
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm check && pnpm test`
Expected: PASS.

```bash
git add src/web/screens/Stats.tsx src/web/lib/i18n.ts
git commit -m "feat(billing): premium gates on stats month view and growth chart" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, DECISIONS, roadmap status, final verification

**Files:**
- Modify: `DECISIONS.md`
- Modify: `CLAUDE.md` (roadmap status block)
- Modify: `SMOKE-TEST.md` (if present — go-live steps)

**Interfaces:** none (documentation).

- [ ] **Step 1: Add a DECISIONS.md entry** (match the file's existing entry format — read it first). Content to record:

- @better-auth/stripe with org-level subscriptions AND org-level customers (`customerType: "organization"`): family owns entitlement + Stripe customer; any family admin can manage billing.
- `organization.plan` values `free|premium|lifetime|comp`; webhooks only move free↔premium; lifetime via one-time checkout through `onEvent`; comp via audited sysadmin override (only free/comp settable by hand).
- Soft-lock downgrade: API keys persist but stop authenticating (402 PLAN_REQUIRED).
- Price IDs via env secrets, NOK-only, tax handled by Stripe Tax (inclusive prices), displayed prices hardcoded i18n strings.
- No trial; everyone (incl. alpha families) starts free.
- Webhook signature verification confirmed working under nodejs_compat (or the fallback taken — record what actually happened in Task 4).
- Whatever deviations the implementation actually made (e.g. `customer_email` vs `customer` on lifetime checkout, portal method naming).

- [ ] **Step 2: Update the CLAUDE.md status block** — extend the `> Status` note: Phase 9 shipped (Stripe billing: Premium 20 kr/mo · 200 kr/yr · 400 kr lifetime via @better-auth/stripe, org-level subscriptions + customers, plan values free/premium/lifetime/comp, soft-lock gates on growth charts/API keys/CSV/month stats, audited admin comp override). Note that admin billing tools + coupons remain the post-Phase-9 backlog item.

- [ ] **Step 3: Update SMOKE-TEST.md go-live steps** (if the file exists) with the Stripe go-live checklist:

1. `wrangler secret put` all five STRIPE_* values (live mode).
2. In the Stripe dashboard: webhook endpoint `https://app.pjokk.no/api/auth/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`; copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Verify all three prices are NOK and tax behavior **inclusive**; Stripe Tax enabled.
4. Test-mode end-to-end pass first: subscribe monthly with card 4242…, verify plan flips to premium, open portal, cancel, verify downgrade at period end; buy lifetime, verify plan flips to lifetime; comp + revoke a family in /admin.

- [ ] **Step 4: Final full verification**

Run: `pnpm check && pnpm test && pnpm build`
Expected: all PASS, build succeeds (bundle-size sanity: stripe SDK is server-side only; verify the web bundle didn't balloon — `@better-auth/stripe/client` is small).

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md CLAUDE.md SMOKE-TEST.md
git commit -m "docs(billing): phase 9 decisions, roadmap status, stripe go-live checklist" -m "Phase 9" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
