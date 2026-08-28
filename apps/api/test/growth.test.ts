import { describe, expect, it } from "bun:test";
import { referenceWeight, weightPercentile } from "../../../src/web/lib/growth";

// Anchors from the WHO weight-for-age tables (canonical published medians).
describe("WHO weight-for-age percentiles", () => {
  it("the published median is the 50th percentile", () => {
    // Boys at birth: M = 3.3464 kg; girls at 12 months: M = 8.9481 kg.
    expect(weightPercentile("boy", 0, 3.3464)).toBeCloseTo(50, 1);
    expect(weightPercentile("girl", 12, 8.9481)).toBeCloseTo(50, 1);
  });

  it("reference curves round-trip through the percentile function", () => {
    for (const sex of ["girl", "boy"] as const) {
      for (const age of [0.5, 6, 10.3, 24, 59]) {
        const p97w = referenceWeight(sex, age, 1.8808)!;
        expect(weightPercentile(sex, age, p97w)).toBeCloseTo(97, 0);
        const p3w = referenceWeight(sex, age, -1.8808)!;
        expect(weightPercentile(sex, age, p3w)).toBeCloseTo(3, 0);
      }
    }
  });

  it("is monotone in weight and sane at the tails", () => {
    const low = weightPercentile("girl", 10, 7.0)!;
    const high = weightPercentile("girl", 10, 10.0)!;
    expect(low).toBeLessThan(high);
    expect(weightPercentile("girl", 10, 4)).toBeLessThan(1);
    expect(weightPercentile("girl", 10, 15)).toBeGreaterThan(99);
  });

  it("returns null outside the table", () => {
    expect(weightPercentile("boy", 61, 20)).toBeNull();
    expect(weightPercentile("boy", -1, 3)).toBeNull();
  });
});
