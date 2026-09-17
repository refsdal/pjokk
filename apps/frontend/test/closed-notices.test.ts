import { describe, expect, it } from "bun:test";
import { closedNotices } from "../src/lib/calendar-ui";

// Home's "Daycare is closed tomorrow" (issue #110).
const now = new Date(2026, 9, 8, 19, 30); // Thursday evening
const ev = (id: string, d: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Event ${id}`,
  category: "daycare" as const,
  closed: true,
  startTime: new Date(2026, 9, d, 0, 0).toISOString(),
  ...over,
});

describe("closedNotices", () => {
  it("says today and tomorrow, today first, and nothing further out", () => {
    const got = closedNotices([ev("c", 10), ev("b", 9), ev("a", 8)], now);
    expect(got.map((n) => [n.when, n.title])).toEqual([
      ["today", "Event a"],
      ["tomorrow", "Event b"],
    ]);
  });

  it("ignores an open barnehage event and a closed flag on anything else", () => {
    expect(closedNotices([ev("m", 9, { closed: false })], now)).toEqual([]);
    expect(closedNotices([ev("d", 9, { category: "doctor" })], now)).toEqual(
      [],
    );
  });

  it("goes by the local day, so late this evening is still today", () => {
    const late = ev("l", 8, {
      startTime: new Date(2026, 9, 8, 23, 30).toISOString(),
    });
    expect(closedNotices([late], now)[0]?.when).toBe("today");
  });

  it("keeps two occurrences of one series apart", () => {
    const series = [ev("s", 8), ev("s", 9)];
    const ids = closedNotices(series, now).map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });
});
