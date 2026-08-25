import { eq } from "drizzle-orm";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canUse } from "../src/worker/entitlements";
import { applySubscriptionStatus, grantLifetime } from "../src/worker/billing";
import {
  addMember,
  api,
  createUser,
  db,
  createFamily,
  rig,
  signIn,
} from "./helpers";
import { schema } from "../src/worker/db";

// biome-ignore lint/suspicious/noExportsInTest: Shared test helpers for billing tasks
export const planOf = async (id: string) =>
  (
    await db()
      .select({ plan: schema.organization.plan })
      .from(schema.organization)
      .where(eq(schema.organization.id, id))
  )[0]!.plan;

// biome-ignore lint/suspicious/noExportsInTest: Shared test helpers for billing tasks
export const setPlan = (id: string, plan: string) =>
  db()
    .update(schema.organization)
    .set({ plan })
    .where(eq(schema.organization.id, id));

describe("canUse", () => {
  it("denies premium features on free, allows on every paid plan", () => {
    for (const feature of [
      "growthCharts",
      "apiKeys",
      "csvExport",
      "statsMonth",
    ] as const) {
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
