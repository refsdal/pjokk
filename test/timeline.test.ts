import { describe, expect, it } from "bun:test";
import { api, rig } from "./helpers";
import type { Timeline } from "../src/shared/schemas";

async function seedDay(a: Awaited<ReturnType<typeof rig>>, now: number) {
  const H = 3600_000;
  const post = (path: string, body: Record<string, unknown>) =>
    api(path, { method: "POST", cookie: a.cookie, body });
  await post("/api/feeds", {
    babyId: a.baby.id,
    time: new Date(now - 6 * H).toISOString(),
    type: "bottle",
    amountMl: 120,
  });
  await post("/api/diapers", {
    babyId: a.baby.id,
    time: new Date(now - 5 * H).toISOString(),
    type: "wet",
  });
  await post("/api/sleep", {
    babyId: a.baby.id,
    startTime: new Date(now - 4 * H).toISOString(),
    endTime: new Date(now - 3 * H).toISOString(),
  });
  await post("/api/feeds", {
    babyId: a.baby.id,
    time: new Date(now - 2 * H).toISOString(),
    type: "breast",
    side: "left",
    durationMin: 15,
  });
  await post("/api/sleep", {
    babyId: a.baby.id,
    startTime: new Date(now - 1 * H).toISOString(),
  }); // active
}

const get = async (cookie: string, qs: string) => {
  const res = await api(`/api/timeline?${qs}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as Timeline;
};

describe("timeline", () => {
  it("merges all kinds newest-first, sleep by start time", async () => {
    const a = await rig();
    await seedDay(a, Date.now());
    const { entries, nextCursor } = await get(a.cookie, `babyId=${a.baby.id}`);
    expect(entries.map((e) => e.kind)).toEqual([
      "sleep",
      "feed",
      "sleep",
      "diaper",
      "feed",
    ]);
    expect(nextCursor).toBeNull();
    const active = entries[0]!;
    expect(active.kind === "sleep" && active.endTime).toBeNull();
    expect(entries.every((e) => e.caretakerName === "Rig admin")).toBe(true);
  });

  it("filters by kind", async () => {
    const a = await rig();
    await seedDay(a, Date.now());
    const feeds = await get(a.cookie, `babyId=${a.baby.id}&filter=feeds`);
    expect(feeds.entries).toHaveLength(2);
    expect(feeds.entries.every((e) => e.kind === "feed")).toBe(true);
    const sleep = await get(a.cookie, `babyId=${a.baby.id}&filter=sleep`);
    expect(sleep.entries).toHaveLength(2);
  });

  it("paginates with a before-cursor, including single-kind tails", async () => {
    const a = await rig();
    const now = Date.now();
    // 5 feeds only: with limit=2 the naive merged-length check would stall.
    for (let i = 0; i < 5; i++) {
      await api("/api/feeds", {
        method: "POST",
        cookie: a.cookie,
        body: {
          babyId: a.baby.id,
          time: new Date(now - i * 3600_000).toISOString(),
          type: "bottle",
          amountMl: 100 + i,
        },
      });
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const qs: string =
        `babyId=${a.baby.id}&limit=2` +
        (cursor ? `&before=${encodeURIComponent(cursor)}` : "");
      const result = await get(a.cookie, qs);
      for (const e of result.entries) {
        expect(e.kind).toBe("feed");
        if (e.kind === "feed") seen.push(e.amountMl!);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([100, 101, 102, 103, 104]);
  });

  it("paginates a mixed-kind page where no single source fills the quota", async () => {
    const a = await rig();
    await seedDay(a, Date.now()); // 5 entries: 2 feeds, 1 diaper, 2 sleeps
    const first = await get(a.cookie, `babyId=${a.baby.id}&limit=3`);
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await get(
      a.cookie,
      `babyId=${a.baby.id}&limit=3&before=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.entries).toHaveLength(2);
    const kinds = [...first.entries, ...second.entries].map((e) => e.kind);
    expect(kinds).toEqual(["sleep", "feed", "sleep", "diaper", "feed"]);
  });

  it("is family-scoped", async () => {
    const a = await rig("Family A");
    const b = await rig("Family B");
    await seedDay(a, Date.now());
    // B can't read A's baby timeline at all.
    const res = await api(`/api/timeline?babyId=${a.baby.id}`, {
      cookie: b.cookie,
    });
    expect(res.status).toBe(404);
  });
});
