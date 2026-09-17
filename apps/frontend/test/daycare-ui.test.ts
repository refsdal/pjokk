import { describe, expect, it } from "bun:test";
import { predatesDropOff } from "../src/lib/daycare-ui";

// Home's Last feed / Last diaper cards gain "At daycare since then" only
// when the entry is older than the drop-off (issue #105): that is when
// "7 hours ago" would otherwise read as news.
describe("predatesDropOff", () => {
  const active = { startTime: "2026-09-08T08:10:00Z" };

  it("is true for an entry logged before the drop-off", () => {
    expect(predatesDropOff("2026-09-08T07:15:00Z", active)).toBe(true);
  });

  it("is false once something is logged after it", () => {
    expect(predatesDropOff("2026-09-08T11:30:00Z", active)).toBe(false);
  });

  it("is false at home, and with nothing logged at all", () => {
    expect(predatesDropOff("2026-09-08T07:15:00Z", null)).toBe(false);
    expect(predatesDropOff(null, active)).toBe(false);
    expect(predatesDropOff(undefined, undefined)).toBe(false);
  });
});
