import { describe, expect, it } from "bun:test";
import { formatRelative, toLocalDateInput } from "../src/lib/time";

describe("time helpers", () => {
  it("stays relative across midnight", () => {
    const now = new Date("2026-08-25T00:30:00");
    expect(formatRelative(new Date("2026-08-24T22:30:00"), now)).toBe(
      "2 h ago",
    );
    // ≥24h ago on the previous calendar day → yesterday + clock.
    expect(
      formatRelative(
        new Date("2026-08-24T00:15:00"),
        new Date("2026-08-25T01:30:00"),
      ).startsWith("yesterday"),
    ).toBe(true);
  });

  it("formats date inputs in local time", () => {
    const d = new Date(2026, 7, 25, 0, 30); // local 25 Aug, 00:30
    expect(toLocalDateInput(d)).toBe("2026-08-25");
  });
});
