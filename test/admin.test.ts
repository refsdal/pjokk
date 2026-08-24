import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/worker/db";
import { api, db, rig } from "./helpers";
import type { AdminFamilySchema } from "../src/shared/schemas";
import type { z } from "@hono/zod-openapi";

type AdminFamily = z.infer<typeof AdminFamilySchema>;

async function makeSysadmin(userId: string) {
  await db()
    .update(schema.user)
    .set({ role: "admin" })
    .where(eq(schema.user.id, userId));
}

describe("system admin", () => {
  it("gates every /api/admin endpoint on the admin role", async () => {
    const a = await rig();
    // Family admin ≠ system admin.
    expect((await api("/api/admin/stats", { cookie: a.cookie })).status).toBe(
      403,
    );
    expect((await api("/api/admin/stats")).status).toBe(401);

    await makeSysadmin(a.user.id);
    expect((await api("/api/admin/stats", { cookie: a.cookie })).status).toBe(
      200,
    );
  });

  it("reports platform stats and family overview", async () => {
    // Storage may persist across tests in this file — assert deltas, not
    // absolutes, and use a unique family name.
    const familyName = `Admin family ${Date.now()}`;
    const a = await rig(familyName);
    await makeSysadmin(a.user.id);
    const getStats = async () =>
      (await (await api("/api/admin/stats", { cookie: a.cookie })).json()) as {
        families: number;
        users: number;
        coreLogs: number;
      };
    const before = await getStats();

    await rig("Other family");
    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 100,
      },
    });

    const after = await getStats();
    expect(after.families).toBe(before.families + 1);
    expect(after.users).toBe(before.users + 1);
    expect(after.coreLogs).toBe(before.coreLogs + 1);

    const families = (await (
      await api("/api/admin/families", { cookie: a.cookie })
    ).json()) as AdminFamily[];
    const mine = families.find((f) => f.name === familyName)!;
    expect(mine.members).toBe(1);
    expect(mine.babies).toBe(1);
    expect(mine.lastFeedAt).not.toBeNull();
  });

  it("deletes a family with cascade and writes the audit trail", async () => {
    const a = await rig("Admin family");
    const victim = await rig("Doomed family");
    await makeSysadmin(a.user.id);
    await api("/api/feeds", {
      method: "POST",
      cookie: victim.cookie,
      body: {
        babyId: victim.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 90,
      },
    });

    const del = await api(`/api/admin/families/${victim.family.id}`, {
      method: "DELETE",
      cookie: a.cookie,
    });
    expect(del.status).toBe(200);

    // Org + members + babies + logs all gone.
    expect(
      await db()
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, victim.family.id)),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(schema.feedLog)
        .where(eq(schema.feedLog.familyId, victim.family.id)),
    ).toHaveLength(0);

    const audit = (await (
      await api("/api/admin/audit", { cookie: a.cookie })
    ).json()) as { action: string; target: string; detail: string | null }[];
    expect(audit[0]!.action).toBe("family.delete");
    expect(audit[0]!.target).toBe(victim.family.id);
    expect(audit[0]!.detail).toBe("Doomed family");
  });

  it("better-auth admin endpoints honor the role", async () => {
    const a = await rig();
    // Not a sysadmin yet: refused.
    const denied = await api("/api/auth/admin/list-users?limit=10", {
      cookie: a.cookie,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);

    await makeSysadmin(a.user.id);
    const res = await api("/api/auth/admin/list-users?limit=10", {
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string }[] };
    expect(body.users.length).toBeGreaterThan(0);
  });
});
