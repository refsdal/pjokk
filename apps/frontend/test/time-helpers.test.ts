import { describe, expect, it } from "bun:test";
import { formatRelative, toLocalDateInput } from "../src/lib/time";

// Relative time is the whole of "status before action" (CLAUDE.md §1): the
// home screen answers "when did she last eat / sleep / get changed" without a
// tap, and it answers in elapsed time rather than a clock reading.
//
// It used to collapse to whole hours the moment it passed 60 minutes, so a
// baby who woke at 1 h 32 m read as "1 hour" for a solid hour — the reading
// went BACKWARDS in precision exactly when the number started mattering.
// Under an hour it was already minute-accurate; now it stays that way all the
// way to 24 h.

describe("formatRelative", () => {
  const at = (h: number, m: number) =>
    new Date(2026, 7, 25, 12, 0).getTime() - (h * 60 + m) * 60_000;
  const now = new Date(2026, 7, 25, 12, 0);
  const ago = (h: number, m: number) => formatRelative(new Date(at(h, m)), now);

  it("says just now under a minute", () => {
    expect(ago(0, 0)).toBe("just now");
  });

  it("counts minutes under an hour", () => {
    expect(ago(0, 45)).toBe("45 minutes ago");
    expect(ago(0, 59)).toBe("59 minutes ago");
  });

  it("keeps the minutes past the hour", () => {
    // The reported bug: this said "1 hour" for the whole of the 32 minutes.
    expect(ago(1, 32)).toBe("1 hour 32 minutes ago");
    expect(ago(5, 7)).toBe("5 hours 7 minutes ago");
    expect(ago(23, 59)).toBe("23 hours 59 minutes ago");
  });

  it("drops the minutes when there are none", () => {
    // "1 hour 0 minutes ago" is worse than what it replaced.
    expect(ago(1, 0)).toBe("1 hour ago");
    expect(ago(2, 0)).toBe("2 hours ago");
  });

  it("uses singular words for exactly one", () => {
    expect(ago(0, 1)).toBe("1 minute ago");
    expect(ago(1, 1)).toBe("1 hour 1 minute ago");
  });

  it("stays relative across midnight", () => {
    const midnight = new Date("2026-08-25T00:30:00");
    expect(formatRelative(new Date("2026-08-24T22:30:00"), midnight)).toBe(
      "2 hours ago",
    );
    // ≥24h ago on the previous calendar day → yesterday + clock.
    expect(
      formatRelative(
        new Date("2026-08-24T00:15:00"),
        new Date("2026-08-25T01:30:00"),
      ).startsWith("yesterday"),
    ).toBe(true);
  });

  it("hands over to the date forms at 24 hours", () => {
    // The last minute that is still elapsed time, and the first that is not.
    expect(ago(23, 59)).toBe("23 hours 59 minutes ago");
    expect(ago(24, 0)).not.toContain("ago");
  });
});

describe("time helpers", () => {
  it("formats date inputs in local time", () => {
    const d = new Date(2026, 7, 25, 0, 30); // local 25 Aug, 00:30
    expect(toLocalDateInput(d)).toBe("2026-08-25");
  });
});
