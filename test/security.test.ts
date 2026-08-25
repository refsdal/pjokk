import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/worker/db";
import { purgeOrphanUsers } from "../src/worker/scheduled";
import { api, createUser, db, rig, signIn } from "./helpers";

describe("security hardening", () => {
  it("rate-limits password sign-in attempts (H1)", async () => {
    const victim = await createUser("Target");
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const res = await SELF.fetch("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          // Own IP bucket so this test doesn't starve the file's other
          // sign-ins (the limiter is per client IP).
          "cf-connecting-ip": "203.0.113.7",
        },
        body: JSON.stringify({ email: victim.email, password: `guess-${i}` }),
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(limited).toBe(true);
  });

  it("only system admins can create families (H2)", async () => {
    const a = await rig();
    const attempt = () =>
      api("/api/auth/organization/create", {
        method: "POST",
        cookie: a.cookie,
        body: { name: "Rogue family", slug: `rogue-${Date.now()}` },
      });

    const denied = await attempt();
    expect(denied.status).toBeGreaterThanOrEqual(400);

    await db()
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, a.user.id));
    const allowed = await attempt();
    expect(allowed.status).toBe(200);
  });

  it("purges week-old accounts with no family; keeps members and admins (H2)", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    const orphan = await createUser("Orphan");
    const freshOrphan = await createUser("Fresh orphan");
    const adminOrphan = await createUser("Admin no family");
    const memberUser = (await rig()).user;
    await db()
      .update(schema.user)
      .set({ createdAt: old })
      .where(eq(schema.user.id, orphan.id));
    await db()
      .update(schema.user)
      .set({ createdAt: old, role: "admin" })
      .where(eq(schema.user.id, adminOrphan.id));
    await db()
      .update(schema.user)
      .set({ createdAt: old })
      .where(eq(schema.user.id, memberUser.id));

    const purged = await purgeOrphanUsers(env);
    expect(purged).toBeGreaterThanOrEqual(1);

    const remaining = (
      await db().select({ id: schema.user.id }).from(schema.user)
    ).map((u) => u.id);
    expect(remaining).not.toContain(orphan.id);
    expect(remaining).toContain(freshOrphan.id); // < 7 days old
    expect(remaining).toContain(adminOrphan.id); // sysadmin
    expect(remaining).toContain(memberUser.id); // has a family
  });

  it("API responses carry security headers (M3)", async () => {
    const res = await api("/api/invites/info/NOPE");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age");
  });
});

describe("safe user deletion (M5)", () => {
  it("reassigns log attribution to the tombstone, then deletes", async () => {
    const a = await rig();
    await db()
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, a.user.id));

    // A second caretaker with history.
    const victim = await createUser("Leaving caretaker");
    await db()
      .insert(schema.member)
      .values({
        id: `mem_${Date.now()}`,
        organizationId: a.family.id,
        userId: victim.id,
        role: "member",
        createdAt: new Date(),
      });
    const victimCookie = await signIn(victim.email);
    await api("/api/feeds", {
      method: "POST",
      cookie: victimCookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 111,
      },
    });

    // Self-delete refused; deleting the victim succeeds.
    expect(
      (
        await api(`/api/admin/users/${a.user.id}/delete`, {
          method: "POST",
          cookie: a.cookie,
        })
      ).status,
    ).toBe(400);
    const res = await api(`/api/admin/users/${victim.id}/delete`, {
      method: "POST",
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);

    // Account gone, history intact under the tombstone.
    expect(
      await db()
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, victim.id)),
    ).toHaveLength(0);
    const feeds = (await (
      await api(`/api/feeds?babyId=${a.baby.id}`, { cookie: a.cookie })
    ).json()) as { amountMl: number; caretakerName: string }[];
    const kept = feeds.find((f) => f.amountMl === 111)!;
    expect(kept.caretakerName).toBe("Deleted user");
  });
});
