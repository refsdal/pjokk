import { describe, expect, it } from "bun:test";
import { directionFor } from "../src/components/Sheet";

// The render itself needs a DOM (vaul is a Radix dialog with portals), so
// the panel is exercised by e2e/layout.spec.ts. What can be pinned here is
// the tier → direction rule (spec §3): a bottom drawer on the phone, a right
// panel from md up.
describe("Sheet direction", () => {
  it("is a bottom drawer only at compact", () => {
    expect(directionFor("compact")).toBe("bottom");
    expect(directionFor("regular")).toBe("right");
    expect(directionFor("wide")).toBe("right");
  });
});
