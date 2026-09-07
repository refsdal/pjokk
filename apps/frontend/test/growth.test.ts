import { describe, expect, it } from "bun:test";
import {
  growthPercentile,
  referenceValue,
  referenceWeight,
  weightPercentile,
} from "../src/lib/growth";

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

// Issue #47: length/height-for-age and head-circumference-for-age, the
// same LMS maths over two more bundled WHO tables. Anchors are the WHO
// published medians in the tables (boys' length at birth 49.8842 cm, girls'
// at 12 months 74.015 cm; boys' head at birth 34.4618 cm, girls' at 12
// months 44.8965 cm).
describe("WHO length-for-age and head-for-age percentiles", () => {
  it("the published medians are the 50th percentile", () => {
    expect(growthPercentile("length", "boy", 0, 49.8842)).toBeCloseTo(50, 1);
    expect(growthPercentile("length", "girl", 12, 74.015)).toBeCloseTo(50, 1);
    expect(growthPercentile("head", "boy", 0, 34.4618)).toBeCloseTo(50, 1);
    expect(growthPercentile("head", "girl", 12, 44.8965)).toBeCloseTo(50, 1);
  });

  it("reference curves round-trip through the percentile function", () => {
    for (const type of ["length", "head"] as const) {
      for (const sex of ["girl", "boy"] as const) {
        for (const age of [0.5, 6, 23.9, 24.1, 40, 59]) {
          const hi = referenceValue(type, sex, age, 1.8808)!;
          expect(growthPercentile(type, sex, age, hi)).toBeCloseTo(97, 0);
          const lo = referenceValue(type, sex, age, -1.8808)!;
          expect(growthPercentile(type, sex, age, lo)).toBeCloseTo(3, 0);
        }
      }
    }
  });

  it("the length table keeps the recumbent row at 24 months", () => {
    // WHO lists month 24 twice (length, then standing height 0.7 cm lower);
    // the length row is what Pjokk's `length` type stores.
    expect(referenceValue("length", "boy", 24, 0)).toBeCloseTo(87.8161, 3);
  });

  it("returns null outside the table and the weight wrappers still agree", () => {
    expect(growthPercentile("head", "girl", 61, 45)).toBeNull();
    expect(weightPercentile("boy", 0, 3.3464)).toBe(
      growthPercentile("weight", "boy", 0, 3.3464),
    );
  });
});
