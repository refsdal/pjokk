import { describe, expect, it } from "bun:test";
import {
  consecutiveDays,
  nextFraction,
  totalLine,
} from "../src/lib/care-days-ui";

// Days at home with an ill child (issue #108).
describe("nextFraction", () => {
  it("walks none, whole, half, none", () => {
    expect(nextFraction(undefined)).toBe(1);
    expect(nextFraction(1)).toBe(0.5);
    expect(nextFraction(0.5)).toBeUndefined();
  });
});

describe("totalLine", () => {
  it("states no entitlement for someone who has set no number", () => {
    expect(totalLine({ used: 4.5, quota: null })).toBe("4.5 days");
    expect(totalLine({ used: 1, quota: null })).toBe("1 day");
    expect(totalLine({ used: 0, quota: null })).toBe("0 days");
  });

  it("counts against the person's own number", () => {
    expect(totalLine({ used: 4.5, quota: 10 })).toBe("4.5 of 10 days");
    expect(totalLine({ used: 1, quota: 10 })).toBe("1 of 10 days");
  });
});

describe("consecutiveDays", () => {
  const day = (userId: string, date: string) => ({ userId, date });
  const days = [
    day("anne", "2026-03-13"),
    day("anne", "2026-03-16"),
    day("anne", "2026-03-17"),
    day("bo", "2026-03-18"),
    day("anne", "2026-03-18"),
    day("anne", "2026-03-19"),
  ];

  it("counts the run that ends on the day, for that person", () => {
    expect(consecutiveDays(days, "anne", "2026-03-19")).toBe(4);
    expect(consecutiveDays(days, "anne", "2026-03-17")).toBe(2);
    expect(consecutiveDays(days, "bo", "2026-03-19")).toBe(0);
    expect(consecutiveDays(days, "bo", "2026-03-18")).toBe(1);
  });

  it("is about the calendar: a weekend gap breaks it, a month end does not", () => {
    expect(consecutiveDays(days, "anne", "2026-03-16")).toBe(1);
    const turn = [day("anne", "2026-02-28"), day("anne", "2026-03-01")];
    expect(consecutiveDays(turn, "anne", "2026-03-01")).toBe(2);
  });
});
