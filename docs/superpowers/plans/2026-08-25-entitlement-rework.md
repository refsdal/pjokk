# Entitlement Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the free tier to 1 baby + feed/diaper/sleep/medicine; the five other activity types and additional babies become Premium — grayed-out (never hidden) client-side, 402-gated server-side.

**Architecture:** Extends the Phase 9 entitlement machinery: two new `Feature` values in `canUse`, a `gated` flag on the other-logs route factory (create-only gates, medicine exempt), a baby-count check in the babies create handler, and muted/lock treatments on the More sheet and Babies section. Soft-lock throughout: existing data stays visible and editable.

**Tech Stack:** Hono + @hono/zod-openapi, Drizzle/D1, React 19 + TanStack, vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-08-25-entitlement-rework-design.md` — read first.

## Global Constraints

- Gate response everywhere: HTTP 402, `{ error: "Premium required", code: "PLAN_REQUIRED" }`.
- All plan reads via `canUse({ plan: c.var.plan }, feature)` — never inline `plan !== "free"` on the server. (`c.var.plan` is set by requireFamily.)
- Medicine is NOT gated, anywhere.
- GET/PATCH/DELETE of gated types stay open on free (soft lock); only POST is gated. Baby limit gates only POST /api/babies when the family already has ≥1 baby.
- Every new t() literal needs an `nb` entry in `src/web/lib/i18n.ts` (CI guard).
- pnpm ONLY via the wrapper the controller names in the dispatch.
- Conventional Commits + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification: `pnpm check`, `pnpm test`, `pnpm build`.

---

### Task 1: Server gates — otherActivities + multipleBabies (TDD)

**Files:**
- Modify: `src/worker/entitlements.ts`
- Modify: `src/worker/routes/other-logs.ts` (factory + instantiations)
- Modify: `src/worker/routes/babies.ts` (create handler)
- Test: `test/entitlement-rework.test.ts` (create)

**Interfaces:**
- Produces: `Feature` union gains `"otherActivities" | "multipleBabies"` (both require premium in the map). `makeLogRoutes` cfg gains `gated: boolean`; create route gains a 402 response and the createHandler starts with the gate. Instantiations: medicine `gated: false`; bath, note, milestone, measurement, pump `gated: true`. `POST /api/babies` 402s when `!canUse(..., "multipleBabies")` and `(await c.var.fam.listBabies()).length >= 1`, BEFORE creating.

- [ ] **Step 1: Write the failing tests**

Create `test/entitlement-rework.test.ts` using the conventions of `test/feedback-batch.test.ts` (helpers `rig`, `api`, `setPlan` from `./helpers`; read the other-logs create body contracts in `test/other-logs.test.ts` first and mirror them):

```ts
import { describe, expect, it } from "vitest";
import { api, rig, setPlan } from "./helpers";

const iso = () => new Date().toISOString();

describe("free tier activity gates", () => {
  it("medicine create stays free", async () => {
    const { baby, cookie } = await rig();
    const res = await api("/api/medicine", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: iso(), name: "D-vitamin", amount: 5, unit: "drops" },
    });
    expect(res.status).toBe(201);
  });

  it("bath create is 402 on free, 201 on premium; existing entries stay editable on free", async () => {
    const { family, baby, cookie } = await rig();
    const denied = await api("/api/bath", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: iso() },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe("PLAN_REQUIRED");

    await setPlan(family.id, "premium");
    const created = await api("/api/bath", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: iso() },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    await setPlan(family.id, "free");
    const list = await api(`/api/bath?babyId=${baby.id}`, { cookie });
    expect(list.status).toBe(200);
    const patched = await api(`/api/bath/${id}`, {
      method: "PATCH",
      cookie,
      body: { time: iso() },
    });
    expect(patched.status).toBe(200);
    const removed = await api(`/api/bath/${id}`, { method: "DELETE", cookie });
    expect(removed.status).toBe(200);
  });

  it("all five gated kinds 402 on free", async () => {
    const { baby, cookie } = await rig();
    const bodies: Record<string, object> = {
      bath: {},
      note: { text: "hei" },
      milestone: { title: "First smile" },
      measurement: { type: "weight", value: 5.2 },
      pump: { amountMl: 90 },
    };
    for (const [kind, extra] of Object.entries(bodies)) {
      const res = await api(`/api/${kind}`, {
        method: "POST",
        cookie,
        body: { babyId: baby.id, time: iso(), ...extra },
      });
      expect(res.status, kind).toBe(402);
    }
  });
});

describe("baby limit", () => {
  it("second baby is 402 on free, allowed on premium; existing babies unaffected", async () => {
    const { family, cookie } = await rig(); // rig creates one baby already
    const denied = await api("/api/babies", {
      method: "POST",
      cookie,
      body: { name: "Second", birthDate: iso() },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe("PLAN_REQUIRED");

    await setPlan(family.id, "premium");
    const ok = await api("/api/babies", {
      method: "POST",
      cookie,
      body: { name: "Second", birthDate: iso() },
    });
    expect(ok.status).toBe(201);

    await setPlan(family.id, "free");
    const list = await api("/api/babies", { cookie });
    expect(((await list.json()) as unknown[]).length).toBe(2);
  });
});
```

(Adapt field names/status codes to the real create contracts — read the routes and existing tests; medicine/measurement/pump schemas have required fields the snippets above guess at.)

- [ ] **Step 2: Run to verify failures** (`pnpm vitest run test/entitlement-rework.test.ts` — creates currently succeed where 402 expected)

- [ ] **Step 3: Implement**

`entitlements.ts`: extend the union and the map:

```ts
export type Feature =
  | "growthCharts"
  | "apiKeys"
  | "csvExport"
  | "statsMonth"
  | "otherActivities"
  | "multipleBabies";
```

(both new entries `true` in `requiresPremium`.)

`other-logs.ts`: add `gated: boolean` to the cfg type; add `402: jsonContent(ErrorSchema, "Premium required")` to the create route responses; at the top of `createHandler`:

```ts
if (cfg.gated && !canUse({ plan: c.var.plan }, "otherActivities")) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

(import `canUse`; the LooseCtx has `c.var` typed as FamEnv Variables, so `c.var.plan` is available.) Set `gated: false` on the medicine instantiation, `gated: true` on bath, note, milestone, measurement, pump.

`babies.ts` create handler, before the insert:

```ts
if (
  !canUse({ plan: c.var.plan }, "multipleBabies") &&
  (await c.var.fam.listBabies()).length >= 1
) {
  return c.json({ error: "Premium required", code: "PLAN_REQUIRED" }, 402);
}
```

plus the 402 response on its route definition.

- [ ] **Step 4: Verify** — focused test PASS, then `pnpm check && pnpm test`. Existing tests that create second babies or gated-type logs on free families will now 402 — fix those tests by setting the family premium in their setup (never weaken the gates). `test/other-logs.test.ts` and `test/household.test.ts` are the likely candidates.

- [ ] **Step 5: Commit**

```bash
git add src/worker/entitlements.ts src/worker/routes/other-logs.ts src/worker/routes/babies.ts test/
git commit -m "feat(entitlements): free tier = 1 baby + feed/diaper/sleep/medicine" -m "Server gates: otherActivities (create-only, medicine exempt) + multipleBabies." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Client — grayed More tiles + Add-baby gate

**Files:**
- Modify: `src/web/components/sheets/OtherLogSheet.tsx` (MoreSheet)
- Modify: `src/web/screens/settings/BabiesSection.tsx`
- Modify: `src/web/lib/i18n.ts`

**Interfaces:**
- Consumes: `useFamily()` from `@/lib/data` (plan: free|premium|lifetime|comp); Task 1's gate semantics.
- Produces: none downstream.

- [ ] **Step 1: MoreSheet locked tiles**

In `MoreSheet` (OtherLogSheet.tsx): `const premium = (useFamily().data?.plan ?? "free") !== "free";` and a module-level `const GATED_KINDS: ReadonlySet<OtherKind> = new Set(["bath", "note", "milestone", "measurement", "pump"]);` (medicine excluded). In the tile map:

```tsx
const locked = !premium && GATED_KINDS.has(kind);
```

Locked tile: same button, but `onClick` becomes `() => { toast(t("Premium feature — upgrade in Settings")); onOpenChange(false); void navigate({ to: "/settings" }); }`; visual: add `opacity-60` to the button, replace the tint class on the icon circle with `text-muted`, and overlay a small lock: inside the icon `<span>`, absolutely-positioned `IconLock` badge (e.g. `absolute -right-1 -bottom-1 h-4 w-4 rounded-full bg-surface p-0.5 text-muted` on a `relative` parent). Keep 44px+ targets. `useNavigate` from `@tanstack/react-router`, `toast` from `@/lib/toast`, `IconLock` from `@tabler/icons-react` (check what OtherLogSheet already imports).

- [ ] **Step 2: BabiesSection add gate**

`const premium = (useFamily().data?.plan ?? "free") !== "free";` and `const atLimit = !premium && (babies.data?.length ?? 0) >= 1;`. When `atLimit`, the Add-baby button keeps its place but renders muted (`text-muted opacity-60`), with `IconLock` instead of `IconPlus`, label `t("Add baby")` plus a small trailing `t("Premium")` badge (same pill style as elsewhere: `rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-bold text-accent`), and `onClick` navigates to `/settings` with the same toast instead of opening the sheet.

- [ ] **Step 3: i18n** — add `"Premium feature — upgrade in Settings": "Premium-funksjon — oppgrader i innstillingene"` (grep first; `Premium` exists).

- [ ] **Step 4: Verify + commit** — `pnpm check && pnpm test && pnpm build`.

```bash
git add src/web/components/sheets/OtherLogSheet.tsx src/web/screens/settings/BabiesSection.tsx src/web/lib/i18n.ts
git commit -m "feat(ui): grayed premium tiles on More sheet + gated Add baby" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Truthful copy — plan-step checklist + billing blurb

**Files:**
- Modify: `src/web/screens/WelcomePlan.tsx` (FREE_FEATURES / PREMIUM_FEATURES)
- Modify: `src/web/screens/settings/BillingSection.tsx` (feature blurb)
- Modify: `src/web/lib/i18n.ts`

**Interfaces:** none.

- [ ] **Step 1: Checklist arrays** in WelcomePlan.tsx:

```ts
const FREE_FEATURES = [
  "1 baby",
  "Feeds, sleep & diapers",
  "Medicine log",
  "Timeline & full history",
  "Week stats",
  "Reminders & night mode",
];
const PREMIUM_FEATURES = [
  "More babies",
  "Bath, notes, milestones & pump",
  "Growth charts (WHO)",
  "Month stats",
  "CSV export",
  "API keys",
];
```

(The animation stagger indexes off array length — verify the cascade delays still compute from `PREMIUM_FEATURES.length`, which they do by construction; no other change needed.)

- [ ] **Step 2: Billing blurb** in BillingSection.tsx: replace the unlock sentence with `t("Premium unlocks more babies, all activity types, growth charts, month stats, CSV export and API keys.")`.

- [ ] **Step 3: i18n** — nb entries for the new literals; REMOVE now-unused keys (the old blurb sentence, and any checklist strings no longer referenced — grep each before removing):

```ts
"1 baby": "1 baby",
"Medicine log": "Medisinlogg",
"More babies": "Flere babyer",
"Bath, notes, milestones & pump": "Bad, notater, milepæler og pumping",
"Premium unlocks more babies, all activity types, growth charts, month stats, CSV export and API keys.":
  "Premium låser opp flere babyer, alle aktivitetstyper, vekstkurver, månedsstatistikk, CSV-eksport og API-nøkler.",
```

- [ ] **Step 4: Verify + commit** — `pnpm check && pnpm test && pnpm build`.

```bash
git add src/web/screens/WelcomePlan.tsx src/web/screens/settings/BillingSection.tsx src/web/lib/i18n.ts
git commit -m "feat(billing): onboarding checklist + billing blurb reflect the new free tier" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Docs + final verification

**Files:**
- Modify: `DECISIONS.md`
- Modify: `docs/superpowers/specs/2026-08-25-stripe-billing-design.md` (one-line pointer: free-tier split superseded — see the entitlement-rework spec)

**Interfaces:** none.

- [ ] **Step 1:** DECISIONS.md entry (match format): the free-tier re-split (1 baby, feed/diaper/sleep/medicine free; five other types + extra babies premium), medicine kept free deliberately (safety-adjacent dose tracking), soft-lock semantics (create-gated only, data stays editable, existing multi-baby free families keep their babies), grayed-not-hidden UI treatment.

- [ ] **Step 2:** Add the superseded-pointer line to the Phase 9 spec's gates section.

- [ ] **Step 3:** Full `pnpm check && pnpm test && pnpm build` — all green.

- [ ] **Step 4: Commit**

```bash
git add DECISIONS.md docs/superpowers/specs/2026-08-25-stripe-billing-design.md
git commit -m "docs(entitlements): record the free-tier re-split" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
