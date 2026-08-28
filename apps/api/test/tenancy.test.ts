import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../src/db";
import { api, createUser, db, rig, signIn } from "./helpers";

// The tenancy promise: no request, however crafted, reads or writes another
// family's rows.

describe("tenancy", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await api("/api/feeds");
    expect(res.status).toBe(401);
  });

  it("rejects a signed-in user with no family", async () => {
    const loner = await createUser("No family");
    const cookie = await signIn(loner.email);
    const res = await api("/api/babies", { cookie });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NO_FAMILY");
  });

  it("scopes lists to the active family", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");

    const feedRes = await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 120,
      },
    });
    expect(feedRes.status).toBe(201);

    const aList = (await (
      await api("/api/feeds", { cookie: a.cookie })
    ).json()) as unknown[];
    const bList = (await (
      await api("/api/feeds", { cookie: b.cookie })
    ).json()) as unknown[];
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(0);

    const aBabies = (await (
      await api("/api/babies", { cookie: a.cookie })
    ).json()) as { id: string }[];
    expect(aBabies.map((x) => x.id)).toEqual([a.baby.id]);
  });

  it("blocks cross-family reads and writes by id", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");

    const feed = (await (
      await api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date().toISOString(),
          type: "bottle",
          amountMl: 100,
        },
      })
    ).json()) as { id: string };

    // B tries to update / delete A's feed by id.
    const patch = await api(`/api/feeds/${feed.id}`, {
      method: "PATCH",
      cookie: b.cookie,
      body: { amountMl: 999 },
    });
    expect(patch.status).toBe(404);

    const del = await api(`/api/feeds/${feed.id}`, {
      method: "DELETE",
      cookie: b.cookie,
    });
    expect(del.status).toBe(404);

    // Still intact for A.
    const fromA = (await (
      await api("/api/feeds", { cookie: a.cookie })
    ).json()) as { id: string; amountMl: number }[];
    expect(fromA[0]!.amountMl).toBe(100);
  });

  it("blocks logging against another family's baby", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");

    const res = await api("/api/feeds", {
      method: "POST",
      cookie: b.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
      },
    });
    expect(res.status).toBe(404);

    const summary = await api(`/api/summary?babyId=${a.baby.id}`, {
      cookie: b.cookie,
    });
    expect(summary.status).toBe(404);
  });

  it("verifies membership, not just the session's active org claim", async () => {
    const a = await rig("Family A");
    // Sign in first (session captures the active org), THEN remove the
    // membership row. The stale session claim must not grant access.
    await db().delete(schema.member).where(eq(schema.member.userId, a.user.id));

    const res = await api("/api/babies", { cookie: a.cookie });
    expect(res.status).toBe(403);
  });
});
