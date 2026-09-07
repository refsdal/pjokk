import { describe, expect, test } from "bun:test";
import { zonedToUtcMs } from "../lib/zoned-time.mjs";

describe("zonedToUtcMs", () => {
  test("reads a wall-clock text in the given zone, across DST", () => {
    expect(
      new Date(
        zonedToUtcMs("2026-01-10 08:00:00", "Europe/Oslo")!,
      ).toISOString(),
    ).toBe("2026-01-10T07:00:00.000Z");
    expect(
      new Date(
        zonedToUtcMs("2026-07-10 08:00:00", "Europe/Oslo")!,
      ).toISOString(),
    ).toBe("2026-07-10T06:00:00.000Z");
    expect(
      new Date(
        zonedToUtcMs("2026-07-10 08:00:00", "America/New_York")!,
      ).toISOString(),
    ).toBe("2026-07-10T12:00:00.000Z");
  });
  test("a date alone lands at noon; an explicit offset wins; junk is null", () => {
    expect(
      new Date(zonedToUtcMs("2026-09-01", "Europe/Oslo")!).toISOString(),
    ).toBe("2026-09-01T10:00:00.000Z");
    expect(
      new Date(
        zonedToUtcMs("2026-09-01T08:00:00+02:00", "America/New_York")!,
      ).toISOString(),
    ).toBe("2026-09-01T06:00:00.000Z");
    expect(zonedToUtcMs("yesterday", "Europe/Oslo")).toBeNull();
  });
});
