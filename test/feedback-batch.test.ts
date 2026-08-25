import { describe, expect, it } from "vitest";
import { addMember, api, createUser, rig, signIn } from "./helpers";

describe("per-side nursing minutes", () => {
  it("stores and returns leftMin/rightMin on breast feeds", async () => {
    const { baby, cookie } = await rig();
    const res = await api("/api/feeds", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: new Date().toISOString(),
        type: "breast",
        side: "both",
        durationMin: 25,
        leftMin: 10,
        rightMin: 15,
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      leftMin: number | null;
      rightMin: number | null;
    };
    expect(created.leftMin).toBe(10);
    expect(created.rightMin).toBe(15);
  });
});

describe("summary today block", () => {
  it("counts today's feeds/diapers/sleep tz-aware", async () => {
    const { baby, cookie } = await rig();
    const now = new Date();
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: now.toISOString(),
        type: "bottle",
        amountMl: 100,
      },
    });
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: {
        babyId: baby.id,
        time: now.toISOString(),
        type: "solids",
        amountMl: 50,
      },
    });
    await api("/api/diapers", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "wet" },
    });
    await api("/api/diapers", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now.toISOString(), type: "both" },
    });
    const tz = now.getTimezoneOffset();
    const res = await api(`/api/summary?babyId=${baby.id}&tz=${tz}`, {
      cookie,
    });
    const s = (await res.json()) as {
      today: {
        feeds: number;
        intakeMl: number;
        solidsG: number;
        wet: number;
        dirty: number;
        both: number;
        sleepMin: number;
      };
    };
    expect(s.today.feeds).toBe(2);
    expect(s.today.intakeMl).toBe(100);
    expect(s.today.solidsG).toBe(50);
    expect(s.today.wet).toBe(1);
    expect(s.today.dirty).toBe(0);
    expect(s.today.both).toBe(1);
  });
});

describe("custom sleep locations", () => {
  it("member reads, only admin writes, family-scoped", async () => {
    const a = await rig();
    const created = await api("/api/sleep-locations", {
      method: "POST",
      cookie: a.cookie,
      body: { name: "Hammock" },
    });
    expect(created.status).toBe(201);

    const member = await createUser("Reader");
    await addMember(member.id, a.family.id, "member");
    const memberCookie = await signIn(member.email);
    const list = await api("/api/sleep-locations", { cookie: memberCookie });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { name: string }[]).map((l) => l.name),
    ).toContain("Hammock");
    expect(
      (
        await api("/api/sleep-locations", {
          method: "POST",
          cookie: memberCookie,
          body: { name: "Nope" },
        })
      ).status,
    ).toBe(403);

    const b = await rig("Other family");
    const otherList = (await (
      await api("/api/sleep-locations", { cookie: b.cookie })
    ).json()) as unknown[];
    expect(otherList).toHaveLength(0);
  });

  it("rejects duplicates (defaults included) and enforces the cap", async () => {
    const { cookie } = await rig();
    expect(
      (
        await api("/api/sleep-locations", {
          method: "POST",
          cookie,
          body: { name: "crib" },
        })
      ).status,
    ).toBe(409);
  });
});
