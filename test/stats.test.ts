import { describe, expect, it } from "vitest";
import { api, rig, setPlan } from "./helpers";
import type { Stats } from "../src/shared/schemas";

const H = 3600_000;

describe("stats", () => {
  it("buckets per local day, splitting sleep across midnight", async () => {
    const a = await rig();
    // Fixed local timezone for determinism: UTC (tz=0).
    const now = new Date();
    // Anchor on YESTERDAY's midnight so the whole scenario lies in the past:
    // the stats route clips sessions at `now`, and a session ending 06:00
    // today would be truncated when the suite runs between 00:00 and 06:00
    // UTC (this test used to flake in exactly that window).
    const anchorMidnight =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      24 * H;

    // A session from 22:00 two days ago to 06:00 yesterday (UTC): 2h in
    // days[4], 6h in days[5].
    await api("/api/sleep", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        startTime: new Date(anchorMidnight - 2 * H).toISOString(),
        endTime: new Date(anchorMidnight + 6 * H).toISOString(),
      },
    });
    // Feeds: 200ml yesterday, 120+60 today. Breast feed adds no ml.
    const feed = (time: number, body: Record<string, unknown>) =>
      api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date(time).toISOString(),
          ...body,
        },
      });
    await feed(anchorMidnight - 5 * H, { type: "bottle", amountMl: 200 });
    await feed(anchorMidnight + 1 * H, { type: "bottle", amountMl: 120 });
    await feed(anchorMidnight + 2 * H, { type: "solids", amountMl: 60 });
    await feed(anchorMidnight + 3 * H, { type: "breast", side: "left" });
    await api("/api/diapers", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date(anchorMidnight + 1 * H).toISOString(),
        type: "wet",
      },
    });

    const res = await api(`/api/stats?babyId=${a.baby.id}&days=7&tz=0`, {
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as Stats;
    expect(stats.days).toHaveLength(7);

    const anchorDay = stats.days[5]!;
    const dayBefore = stats.days[4]!;
    expect(dayBefore.sleepMin).toBe(120);
    expect(anchorDay.sleepMin).toBe(360);
    expect(dayBefore.intakeMl).toBe(200);
    // Intake sums bottle ml only — the solids feed's 60 (grams) don't count.
    expect(anchorDay.intakeMl).toBe(120);
    expect(anchorDay.feeds).toBe(3);
    expect(anchorDay.diapers).toBe(1);
    expect(stats.avgSleepMin).toBe(Math.round((120 + 360) / 7));
    expect(stats.avgIntakeMl).toBe(Math.round(320 / 7));
  });

  it("returns latest weight with its predecessor", async () => {
    const a = await rig();
    // measurements is a gated activity type (Task 1 entitlement rework);
    // this test is about stats math, not the plan gate.
    await setPlan(a.family.id, "premium");
    const post = (daysAgo: number, value: number) =>
      api("/api/measurements", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date(Date.now() - daysAgo * 24 * H).toISOString(),
          type: "weight",
          value,
        },
      });
    await post(20, 7.9);
    await post(2, 8.4);
    // A length measurement must not interfere.
    await api("/api/measurements", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        type: "length",
        value: 71,
      },
    });

    const stats = (await (
      await api(`/api/stats?babyId=${a.baby.id}&tz=0`, { cookie: a.cookie })
    ).json()) as Stats;
    expect(stats.weight?.value).toBe(8.4);
    expect(stats.weight?.prevValue).toBe(7.9);
  });

  it("is family-scoped", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");
    const res = await api(`/api/stats?babyId=${a.baby.id}&tz=0`, {
      cookie: b.cookie,
    });
    expect(res.status).toBe(404);
  });

  it("intake sums bottle ml only — solids grams don't pollute it", async () => {
    const { family, baby, cookie } = await rig();
    await setPlan(family.id, "premium");
    const now = new Date().toISOString();
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now, type: "bottle", amountMl: 120 },
    });
    await api("/api/feeds", {
      method: "POST",
      cookie,
      body: { babyId: baby.id, time: now, type: "solids", amountMl: 80 },
    });
    const res = await api(`/api/stats?babyId=${baby.id}&days=7`, { cookie });
    const s = (await res.json()) as {
      days: { intakeMl: number; feeds: number }[];
    };
    const today = s.days[s.days.length - 1]!;
    expect(today.feeds).toBe(2);
    expect(today.intakeMl).toBe(120);
  });
});

describe("csv export", () => {
  it("exports every kind chronologically, family-scoped", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");
    await setPlan(a.family.id, "premium");
    const now = Date.now();

    await api("/api/feeds", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date(now - 2 * H).toISOString(),
        type: "bottle",
        amountMl: 150,
        notes: 'she said "more", then a,comma',
      },
    });
    await api("/api/medicine", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date(now - 1 * H).toISOString(),
        name: "D-vitamin",
        amount: 5,
        unit: "drops",
      },
    });
    // B's data must NOT leak into A's export.
    await api("/api/feeds", {
      method: "POST",
      cookie: b.cookie,
      body: {
        babyId: b.baby.id,
        time: new Date().toISOString(),
        type: "bottle",
        amountMl: 999,
      },
    });

    const res = await api("/api/export.csv", { cookie: a.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "kind,baby,time,end_time,type,detail,amount,unit,side,duration_min,value,location,caretaker,notes",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("feed");
    expect(lines[1]).toContain('"she said ""more"", then a,comma"');
    expect(lines[2]).toContain("D-vitamin");
    expect(csv).not.toContain("999");

    // Formula injection is neutralized with a leading apostrophe.
    await api("/api/notes", {
      method: "POST",
      cookie: a.cookie,
      body: {
        babyId: a.baby.id,
        time: new Date().toISOString(),
        content: '=HYPERLINK("http://evil.example","x")',
      },
    });
    const csv2 = await (
      await api("/api/export.csv", { cookie: a.cookie })
    ).text();
    expect(csv2).toContain("'=HYPERLINK");
    expect(csv2).not.toMatch(/(^|,)=HYPERLINK/m);

    // Unauthenticated: refused.
    expect((await api("/api/export.csv")).status).toBe(401);
  });
});
