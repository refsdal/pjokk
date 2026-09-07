import { describe, expect, it } from "bun:test";
import { judgeFamily, takeDiscarded } from "../src/lib/family-fence";

// The fence is the one guard the switch flow cannot provide: it compares
// the family the app last rendered with what /api/me says now, so a switch
// made in another tab, on another device, or interrupted mid-way is caught
// on the next resolve (spec §5).
describe("judgeFamily", () => {
  it("records the first family it sees", () => {
    expect(judgeFamily(null, "fam-1")).toBe("recorded");
  });
  it("is quiet while the family is unchanged", () => {
    expect(judgeFamily("fam-1", "fam-1")).toBe("same");
  });
  it("flags a different family", () => {
    expect(judgeFamily("fam-1", "fam-2")).toBe("changed");
  });
  it("ignores a session with no family yet (the Welcome flow)", () => {
    expect(judgeFamily(null, null)).toBe("same");
    expect(judgeFamily("fam-1", null)).toBe("same");
  });
});

// bun test has no localStorage, so every family-fence accessor's try/catch
// path is what actually runs here — this pins takeDiscarded's "nothing
// recorded" (or "storage unavailable") case returning 0 rather than
// throwing.
describe("takeDiscarded", () => {
  it("returns 0 when nothing was recorded", () => {
    expect(takeDiscarded()).toBe(0);
  });
});
