import { eq } from "drizzle-orm";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canUse } from "../src/worker/entitlements";
import { applySubscriptionStatus, grantLifetime } from "../src/worker/billing";
import { db, createFamily } from "./helpers";
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
