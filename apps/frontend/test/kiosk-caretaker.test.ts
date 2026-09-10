import { describe, expect, it } from "bun:test";
import {
  caretakerAfterIdle,
  cautionFor,
  thresholdsToReminders,
} from "../src/lib/kiosk-ui";

// Who is logging on a kiosk device (spec 2026-09-10-kiosk-devices §6).

describe("caretakerAfterIdle", () => {
  it("forgets who is logging when the kiosk dims", () => {
    expect(caretakerAfterIdle("dim", "u1")).toBeNull();
  });
  it("keeps them while the kiosk is awake or waking", () => {
    expect(caretakerAfterIdle("awake", "u1")).toBe("u1");
    expect(caretakerAfterIdle("waking", "u1")).toBe("u1");
    expect(caretakerAfterIdle("awake", null)).toBeNull();
  });
});

describe("thresholdsToReminders", () => {
  it("feeds the family's thresholds to the amber card", () => {
    const rem = thresholdsToReminders([
      { kind: "feed", babyId: null, intervalMin: 180 },
    ]);
    const last = new Date("2026-09-10T08:00:00Z");
    expect(
      cautionFor("feed", last, rem, "b1", new Date("2026-09-10T11:01:00Z")),
    ).toBe(true);
    expect(
      cautionFor("feed", last, rem, "b1", new Date("2026-09-10T10:59:00Z")),
    ).toBe(false);
  });
  it("keeps a baby's own threshold to that baby", () => {
    const rem = thresholdsToReminders([
      { kind: "diaper", babyId: "b2", intervalMin: 60 },
    ]);
    const tenHours = new Date(10 * 3600_000);
    expect(cautionFor("diaper", new Date(0), rem, "b1", tenHours)).toBe(false);
    expect(cautionFor("diaper", new Date(0), rem, "b2", tenHours)).toBe(true);
  });
});
