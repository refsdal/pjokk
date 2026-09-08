import { describe, expect, it } from "bun:test";
import {
  REGULAR_MIN,
  WIDE_MIN,
  tierFor,
  tierFromMatches,
} from "../src/lib/layout";

// The tiers are Tailwind's md (768) and xl (1280): the CSS side of the
// layout is `md:` / `xl:` classes, and everything the JS side decides
// (drawer direction, the wide-only Recent query) must agree with it to the
// pixel, or a window at exactly 768 px gets a side panel and a bottom bar.
describe("tierFor", () => {
  it("matches Tailwind's md and xl breakpoints exactly", () => {
    expect(REGULAR_MIN).toBe(768);
    expect(WIDE_MIN).toBe(1280);
    expect(tierFor(320)).toBe("compact");
    expect(tierFor(767)).toBe("compact");
    expect(tierFor(768)).toBe("regular");
    expect(tierFor(1279)).toBe("regular");
    expect(tierFor(1280)).toBe("wide");
    expect(tierFor(2560)).toBe("wide");
  });
});

describe("tierFromMatches", () => {
  it("derives the tier from the two media queries", () => {
    expect(tierFromMatches(false, false)).toBe("compact");
    expect(tierFromMatches(true, false)).toBe("regular");
    expect(tierFromMatches(true, true)).toBe("wide");
  });
  it("never reports wide without regular (a contradictory pair is regular at most)", () => {
    expect(tierFromMatches(false, true)).toBe("compact");
  });
});
