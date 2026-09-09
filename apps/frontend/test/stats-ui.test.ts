import { describe, expect, test } from "bun:test";
import { formatMinutes, lastNight, napLine } from "../src/lib/stats-ui";

const n = (date: string, longest: number | null, wakings: number | null) => ({
  date,
  longestStretchMin: longest,
  wakings,
});

describe("lastNight", () => {
  test("picks the newest night with data and compares it to the earlier mean", () => {
    const got = lastNight([
      n("2026-01-06", 240, 2),
      n("2026-01-07", null, null),
      n("2026-01-08", 360, 1),
      n("2026-01-09", 330, 0),
      n("2026-01-10", null, null), // tonight, nothing yet
    ]);
    expect(got?.night.date).toBe("2026-01-09");
    expect(got?.night.wakings).toBe(0);
    // mean of 240 and 360 is 300 → +30
    expect(got?.deltaMin).toBe(30);
  });

  test("has no delta with a single night, and null with none", () => {
    expect(lastNight([n("2026-01-09", 300, 1)])?.deltaMin).toBeNull();
    expect(lastNight([n("2026-01-09", null, null)])).toBeNull();
    expect(lastNight([])).toBeNull();
  });
});

test("formatMinutes", () => {
  expect(formatMinutes(260)).toBe("4 h 20 min");
  expect(formatMinutes(120)).toBe("2 h");
  expect(formatMinutes(45)).toBe("45 min");
  expect(formatMinutes(0)).toBe("0 min");
  expect(formatMinutes(90, "t", "m")).toBe("1 t 30 m");
});

describe("napLine", () => {
  const fmt = (min: number) => formatMinutes(min);
  const labels = { nap: "Nap", naps: "naps" };

  test("reads as a duration and a count, like the Intake card's sub-line", () => {
    expect(napLine(75, 3.2, fmt, labels)).toBe("Nap 1 h 15 min · 3.2 naps");
  });

  test("is omitted when no nap ended in the window", () => {
    expect(napLine(0, 0, fmt, labels)).toBeNull();
    // Naps counted but none with a length: nothing worth a line either.
    expect(napLine(0, 1.5, fmt, labels)).toBeNull();
  });

  test("takes its wording from the caller, so it translates", () => {
    expect(napLine(45, 2, fmt, { nap: "Lur", naps: "lurer" })).toBe(
      "Lur 45 min · 2 lurer",
    );
  });
});
