import { describe, expect, it } from "bun:test";
import type { FeedLog, SleepLog } from "@pjokk/shared";
import {
  clockLabel,
  foodRoutine,
  sleepRoutine,
  usualNapSuggestion,
} from "../src/lib/about-me";

// "About <name>" (issue #109): what "usual" means when a stranger plans a
// child's day by it.
const now = new Date(2026, 8, 17, 18, 0);
const at = (daysAgo: number, h: number, m = 0) => {
  const d = new Date(2026, 8, 17 - daysAgo, h, m);
  return d.toISOString();
};
const sleep = (
  type: "nap" | "night",
  start: string,
  end: string,
  location: string | null = null,
): SleepLog =>
  ({
    id: start,
    type,
    startTime: start,
    endTime: end,
    location,
  }) as unknown as SleepLog;
const feed = (over: Partial<FeedLog>): FeedLog =>
  ({
    id: String(Math.random()),
    type: "bottle",
    amountMl: null,
    food: null,
    reaction: null,
    ...over,
  }) as unknown as FeedLog;

describe("sleepRoutine", () => {
  const week = [1, 2, 3, 4, 5].flatMap((d) => [
    sleep("night", at(d + 1, 19, 10), at(d, 6, 20)),
    sleep("nap", at(d, 11, 30 + d), at(d, 13, 5), "Crib"),
  ]);

  it("reads a routine off a week of logs, rounded to five minutes", () => {
    const r = sleepRoutine(week, now);
    expect(clockLabel(r.wakeUp!)).toBe("06:20");
    expect(clockLabel(r.bedtime!)).toBe("19:10");
    expect(clockLabel(r.napStart!)).toBe("11:35");
    expect(r.napsPerDay).toBe(1);
    expect(Math.round(r.napMinutes!)).toBe(92);
    expect(r.napLocation).toBe("Crib");
  });

  it("is a median: one dreadful morning does not move the line", () => {
    const r = sleepRoutine(
      [...week, sleep("night", at(7, 19, 0), at(6, 4, 30))],
      now,
    );
    expect(clockLabel(r.wakeUp!)).toBe("06:20");
  });

  it("takes the day's longest nap as the nap, and counts the catnap", () => {
    const withCatnaps = [
      ...week,
      ...[1, 2, 3].map((d) =>
        sleep("nap", at(d, 16, 0), at(d, 16, 20), "Stroller"),
      ),
    ];
    const r = sleepRoutine(withCatnaps, now);
    expect(clockLabel(r.napStart!)).toBe("11:35");
    expect(r.napsPerDay).toBe(2);
    expect(r.napLocation).toBe("Crib");
  });

  it("ends a night logged in two stretches at the last waking, and starts it at the first", () => {
    const broken = [1, 2, 3].flatMap((d) => [
      sleep("night", at(d + 1, 19, 0), at(d, 2, 0)),
      sleep("night", at(d, 2, 30), at(d, 6, 40)),
    ]);
    const r = sleepRoutine(broken, now);
    expect(clockLabel(r.wakeUp!)).toBe("06:40");
    expect(clockLabel(r.bedtime!)).toBe("19:00");
  });

  it("averages bedtimes across midnight to midnight, not to noon", () => {
    const late = [
      sleep("night", at(3, 23, 50), at(2, 7, 0)),
      sleep("night", at(1, 0, 10), at(1, 7, 0)),
      sleep("night", at(4, 23, 55), at(3, 7, 0)),
    ];
    expect(clockLabel(sleepRoutine(late, now).bedtime!)).toBe("23:55");
  });

  it("says nothing on fewer than three days, on old logs, or on a running sleep", () => {
    const thin = sleepRoutine(week.slice(0, 4), now);
    expect([thin.wakeUp, thin.napStart, thin.napsPerDay]).toEqual([
      null,
      null,
      null,
    ]);
    const old = week.map(
      (s) => ({ ...s, startTime: at(40, 11), endTime: at(40, 12) }) as SleepLog,
    );
    expect(sleepRoutine(old, now).napStart).toBeNull();
    expect(
      sleepRoutine([{ ...week[1]!, endTime: null } as SleepLog], now).napStart,
    ).toBeNull();
  });
});

describe("foodRoutine", () => {
  const feeds = [1, 2, 3, 4].flatMap((d) => [
    feed({ type: "bottle", amountMl: 150 + d * 10, time: at(d, 7) }),
    feed({ type: "bottle", amountMl: 180, time: at(d, 19) }),
    feed({ type: "solids", food: "Grøt", time: at(d, 8) }),
    feed({
      type: "solids",
      food: d % 2 ? "Banan" : "Fiskekaker",
      time: at(d, 12),
    }),
  ]);

  it("counts a usual day and the usual bottle", () => {
    const r = foodRoutine(feeds, now);
    expect(r.bottlesPerDay).toBe(2);
    expect(r.mealsPerDay).toBe(2);
    expect(r.breastPerDay).toBeNull();
    expect(r.bottleMl).toBe(180);
    expect(r.foods).toEqual(["Grøt", "Banan", "Fiskekaker"]);
  });

  it("keeps a reaction however old it is, and lists it once", () => {
    const old = [
      feed({ type: "solids", food: "Egg", reaction: true, time: at(200, 12) }),
      feed({ type: "solids", food: "Egg ", reaction: true, time: at(190, 12) }),
    ];
    const r = foodRoutine([...feeds, ...old], now);
    expect(r.reactions).toEqual(["Egg"]);
    expect(r.foods).not.toContain("Egg");
  });
});

// The usual nap time as a suggestion for the family's own anchor (issue
// #126): barnehage naps first, then the long nap at home, or nothing.
describe("usualNapSuggestion", () => {
  const daycareNap = (d: number, h: number, m: number): SleepLog =>
    ({
      ...sleep("nap", at(d, h, m), at(d, h + 1, m + 20)),
      daycareId: `day-${d}`,
    }) as SleepLog;

  it("goes by the barnehage's naps when there are three, whatever home looks like", () => {
    const sleeps = [
      daycareNap(1, 11, 30),
      daycareNap(2, 11, 40),
      daycareNap(3, 11, 35),
      // Weekend naps at home, later and longer: not what the anchor is for.
      sleep("nap", at(4, 13, 0), at(4, 15, 30)),
      sleep("nap", at(5, 13, 10), at(5, 15, 30)),
      sleep("nap", at(6, 13, 0), at(6, 15, 30)),
    ];
    expect(usualNapSuggestion(sleeps, now)).toEqual({
      minute: 11 * 60 + 35,
      source: "daycare",
    });
  });

  it("falls back to the day's long nap at home, and says so", () => {
    const sleeps = [1, 2, 3].flatMap((d) => [
      sleep("nap", at(d, 12, 5), at(d, 14, 0)),
      sleep("nap", at(d, 16, 30), at(d, 16, 50)), // a catnap is not the nap
    ]);
    expect(usualNapSuggestion(sleeps, now)).toEqual({
      minute: 12 * 60 + 5,
      source: "home",
    });
    // Two barnehage naps are not enough to go by; the home naps still are.
    const mixed = [...sleeps, daycareNap(4, 11, 30), daycareNap(5, 11, 30)];
    expect(usualNapSuggestion(mixed, now)?.source).toBe("home");
  });

  it("suggests nothing from too little, from old logs, or from a running nap", () => {
    expect(
      usualNapSuggestion([daycareNap(1, 11, 30), daycareNap(2, 11, 30)], now),
    ).toBeNull();
    expect(
      usualNapSuggestion(
        [40, 41, 42].map((d) => daycareNap(d, 11, 30)),
        now,
      ),
    ).toBeNull();
    const running = [1, 2, 3].map(
      (d) => ({ ...daycareNap(d, 11, 30), endTime: null }) as SleepLog,
    );
    expect(usualNapSuggestion(running, now)).toBeNull();
    // Night sleep is never a nap, however it is linked.
    const nights = [1, 2, 3].map(
      (d) =>
        ({
          ...sleep("night", at(d, 19, 0), at(d - 1, 6, 0)),
          daycareId: "x",
        }) as SleepLog,
    );
    expect(usualNapSuggestion(nights, now)).toBeNull();
  });
});
