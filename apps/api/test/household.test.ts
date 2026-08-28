import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../src/db";
import {
  addMember,
  api,
  createBaby,
  createUser,
  db,
  rig,
  setPlan,
  signIn,
} from "./helpers";

describe("multiple babies per household", () => {
  it("adds a second baby with isolated summaries", async () => {
    const a = await rig();
    // multipleBabies is a Task 1 entitlement gate; this test is about
    // per-baby data isolation, not the plan gate, so lift to premium first.
    await setPlan(a.family.id, "premium");
    const res = await api("/api/babies", {
      method: "POST",
      cookie: a.cookie,
      body: {
        name: "Emil",
        birthDate: new Date("2024-01-15T00:00:00Z").toISOString(),
        sex: "boy",
      },
    });
    expect(res.status).toBe(201);
    const emil = (await res.json()) as { id: string };

    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: emil.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 200,
      },
    });

    const babies = (await (
      await api("/api/babies", { cookie: a.cookie })
    ).json()) as { id: string }[];
    expect(babies).toHaveLength(2);

    // Nora's summary must not show Emil's feed.
    const noraSummary = (await (
      await api(`/api/summary?babyId=${a.baby.id}`, { cookie: a.cookie })
    ).json()) as { lastFeed: unknown };
    expect(noraSummary.lastFeed).toBeNull();
    const emilSummary = (await (
      await api(`/api/summary?babyId=${emil.id}`, { cookie: a.cookie })
    ).json()) as { lastFeed: { amountMl: number } };
    expect(emilSummary.lastFeed.amountMl).toBe(200);
  });

  it("only family admins delete a baby; deletion cascades logs", async () => {
    const a = await rig();
    const second = await createBaby(a.family.id, "Doomed baby");
    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: second.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 50,
      },
    });

    const member = await createUser("Plain member");
    await addMember(member.id, a.family.id, "member");
    const memberCookie = await signIn(member.email);
    expect(
      (
        await api(`/api/babies/${second.id}`, {
          method: "DELETE",
          cookie: memberCookie,
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await api(`/api/babies/${second.id}`, {
          method: "DELETE",
          cookie: a.cookie,
        })
      ).status,
    ).toBe(200);
    expect(
      await db()
        .select()
        .from(schema.feedLog)
        .where(eq(schema.feedLog.babyId, second.id)),
    ).toHaveLength(0);
  });
});

describe("household member management (better-auth org)", () => {
  it("lists members with the member-row id", async () => {
    const a = await rig();
    const members = (await (
      await api("/api/family/members", { cookie: a.cookie })
    ).json()) as { memberId: string; userId: string }[];
    expect(members[0]!.memberId).toBeTruthy();
    expect(members[0]!.userId).toBe(a.user.id);
  });

  it("family admin can change roles and remove members; removed members lose access", async () => {
    const a = await rig();
    const other = await createUser("Removable");
    await addMember(other.id, a.family.id, "member");
    const otherCookie = await signIn(other.email);
    expect((await api("/api/babies", { cookie: otherCookie })).status).toBe(
      200,
    );

    const members = (await (
      await api("/api/family/members", { cookie: a.cookie })
    ).json()) as { memberId: string; userId: string }[];
    const target = members.find((m) => m.userId === other.id)!;

    // Promote to admin, then demote.
    const promote = await api("/api/auth/organization/update-member-role", {
      method: "POST",
      cookie: a.cookie,
      body: {
        memberId: target.memberId,
        role: "admin",
        organizationId: a.family.id,
      },
    });
    expect(promote.status).toBe(200);

    // Remove from the family.
    const remove = await api("/api/auth/organization/remove-member", {
      method: "POST",
      cookie: a.cookie,
      body: {
        memberIdOrEmail: target.memberId,
        organizationId: a.family.id,
      },
    });
    expect(remove.status).toBe(200);

    // The removed member's session claim no longer grants anything.
    const denied = await api("/api/babies", { cookie: otherCookie });
    expect(denied.status).toBe(403);
  });

  it("plain members cannot manage membership", async () => {
    const a = await rig();
    const mallory = await createUser("Mallory member");
    await addMember(mallory.id, a.family.id, "member");
    const malloryCookie = await signIn(mallory.email);

    const members = (await (
      await api("/api/family/members", { cookie: a.cookie })
    ).json()) as { memberId: string; userId: string }[];
    const admin = members.find((m) => m.userId === a.user.id)!;

    const res = await api("/api/auth/organization/remove-member", {
      method: "POST",
      cookie: malloryCookie,
      body: {
        memberIdOrEmail: admin.memberId,
        organizationId: a.family.id,
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("self-serve family creation", () => {
  const create = (cookie: string, name: string) =>
    api("/api/auth/organization/create", {
      method: "POST",
      cookie,
      body: { name, slug: `${name.toLowerCase()}-${Date.now().toString(36)}` },
    });

  it("a user without a family can create one", async () => {
    const founder = await createUser("Fresh founder");
    const cookie = await signIn(founder.email);
    const res = await create(cookie, "Selfserve");
    expect(res.status).toBe(200);
  });

  it("a user already in a family cannot create another", async () => {
    const a = await rig();
    const other = await createUser("Second family wisher");
    await addMember(other.id, a.family.id, "member");
    const cookie = await signIn(other.email);
    const res = await create(cookie, "Sneaky");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
