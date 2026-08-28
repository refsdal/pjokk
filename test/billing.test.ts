import { eq } from "drizzle-orm";
import {
  SELF,
  addMember,
  api,
  createFamily,
  createUser,
  db,
  planOf,
  rig,
  services,
  setPlan,
  signIn,
} from "./helpers";
import { describe, expect, it } from "bun:test";
import { canUse } from "../src/server/entitlements";
import { applySubscriptionStatus, grantLifetime } from "../src/server/billing";
import { reconcilePlans } from "../src/server/scheduled";
import { schema } from "../src/server/db";

describe("canUse", () => {
  it("denies premium features on free, allows on every paid plan", () => {
    for (const feature of ["growthCharts", "apiKeys", "statsMonth"] as const) {
      expect(canUse({ plan: "free" }, feature)).toBe(false);
      expect(canUse({ plan: "premium" }, feature)).toBe(true);
      expect(canUse({ plan: "lifetime" }, feature)).toBe(true);
      expect(canUse({ plan: "comp" }, feature)).toBe(true);
    }
  });

  it("keeps the CSV export free on every plan", () => {
    // GDPR access/portability: a family's own data is never behind the
    // paywall, whatever the plan says.
    for (const plan of ["free", "premium", "lifetime", "comp"]) {
      expect(canUse({ plan }, "csvExport")).toBe(true);
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

describe("nightly plan reconciliation", () => {
  it("flips a free family with a stray active subscription row to premium", async () => {
    const fam = await createFamily("Reconcile me");
    await db()
      .insert(schema.subscription)
      .values({
        id: `sub_${fam.id}`,
        plan: "premium",
        referenceId: fam.id,
        status: "active",
      });
    expect(await planOf(fam.id)).toBe("free");

    const flipped = await reconcilePlans(services);
    expect(flipped).toBeGreaterThan(0);
    expect(await planOf(fam.id)).toBe("premium");
  });

  it("never touches a lifetime family, even with a stray active sub row", async () => {
    const fam = await createFamily("Lifetime with stray sub");
    await setPlan(fam.id, "lifetime");
    await db()
      .insert(schema.subscription)
      .values({
        id: `sub_${fam.id}`,
        plan: "premium",
        referenceId: fam.id,
        status: "active",
      });

    await reconcilePlans(services);
    expect(await planOf(fam.id)).toBe("lifetime");
  });
});

describe("subscribe-while-lifetime/comp guard", () => {
  const upgradeBody = {
    plan: "premium",
    customerType: "organization",
    successUrl: "/settings",
    cancelUrl: "/settings",
  };

  it("refuses a lifetime family admin trying to start a paid subscription", async () => {
    const { family, cookie } = await rig();
    await setPlan(family.id, "lifetime");
    const res = await api("/api/auth/subscription/upgrade", {
      method: "POST",
      cookie,
      body: { ...upgradeBody, referenceId: family.id },
    });
    // The plugin surfaces an authorizeReference refusal as UNAUTHORIZED.
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  it("authorizes a free family admin (fails later at the Stripe network call, not at the auth gate)", async () => {
    const { family, cookie } = await rig();
    const res = await api("/api/auth/subscription/upgrade", {
      method: "POST",
      cookie,
      body: { ...upgradeBody, referenceId: family.id },
    });
    // authorizeReference passes for "free", so this never hits the
    // UNAUTHORIZED branch; with the fake test Stripe key ("sk_test_fake")
    // the plugin then fails trying to create a Stripe customer — verified
    // to come back as 400 { code: "UNABLE_TO_CREATE_CUSTOMER" }. The exact
    // Stripe-layer error code isn't the point of this test, so only the
    // "didn't get stuck at the auth gate" part is pinned.
    expect(res.status).toBe(400);
    expect([401, 403]).not.toContain(res.status);
  });
});

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

describe("premium gates", () => {
  it("POST /api/keys is 402 on free, 201 on premium", async () => {
    const { family, cookie } = await rig();
    const denied = await api("/api/keys", {
      method: "POST",
      cookie,
      body: { name: "ha", readOnly: true },
    });
    expect(denied.status).toBe(402);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );

    await setPlan(family.id, "premium");
    const ok = await api("/api/keys", {
      method: "POST",
      cookie,
      body: { name: "ha", readOnly: true },
    });
    expect(ok.status).toBe(201);
  });

  it("GET /api/export.csv is 200 on every plan, free included", async () => {
    // Not a premium gate: the export is how a family exercises their GDPR
    // right of access and portability, which cannot be charged for.
    const { family, cookie } = await rig();
    expect((await api("/api/export.csv", { cookie })).status).toBe(200);
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
    expect(((await locked.json()) as { code: string }).code).toBe(
      "PLAN_REQUIRED",
    );
    await setPlan(family.id, "premium");
    expect((await useKey(key)).status).toBe(200);
  });
});

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

  it("GET /api/family never leaks stripeCustomerId to members", async () => {
    const { family } = await rig();
    const member = await createUser("Member");
    await addMember(member.id, family.id, "member");
    const memberCookie = await signIn(member.email);
    const res = await api("/api/family", { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("stripeCustomerId");
  });
});

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
