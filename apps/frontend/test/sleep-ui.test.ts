import { describe, expect, test } from "bun:test";
import { napsLine, sleepNoun } from "../src/lib/sleep-ui";

const fmt = (min: number) =>
  `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

describe("napsLine", () => {
  test("naps and their time today, then last night", () => {
    expect(napsLine({ naps: 2, napMin: 105 }, 630, fmt)).toBe(
      "2 naps · 1:45 today · night 10:30",
    );
  });

  test("one nap is singular", () => {
    expect(napsLine({ naps: 1, napMin: 45 }, null, fmt)).toBe(
      "1 nap · 0:45 today",
    );
  });

  test("before the first nap: no minutes to show, last night still does", () => {
    expect(napsLine({ naps: 0, napMin: 0 }, 630, fmt)).toBe(
      "0 naps today · night 10:30",
    );
  });

  test("no night part without a recent night", () => {
    expect(napsLine({ naps: 0, napMin: 0 }, null, fmt)).toBe("0 naps today");
  });
});

describe("sleepNoun", () => {
  test("a night sleep is named as one; naps and untyped sessions are naps", () => {
    expect(sleepNoun("night")).toBe("night sleep");
    expect(sleepNoun("nap")).toBe("nap");
    expect(sleepNoun(null)).toBe("nap");
  });
});
