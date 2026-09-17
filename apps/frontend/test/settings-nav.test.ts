import { describe, expect, it } from "bun:test";
import { familySection, familySections } from "../src/lib/settings-nav";

// The Family page's doors (Settings restructure): one list feeds the rows
// and the sub-page route, so a section cannot be linked without existing or
// exist without a guard.
describe("familySections", () => {
  it("shows a member everything that is not admin-only", () => {
    const keys = familySections(false).map((s) => s.key);
    expect(keys).toEqual([
      "contacts",
      "daycare",
      "medicines",
      "care-days",
      "calendar-feed",
      "data",
    ]);
  });

  it("adds the admin-only sections for an admin, in display order", () => {
    const keys = familySections(true).map((s) => s.key);
    expect(keys).toEqual([
      "contacts",
      "daycare",
      "medicines",
      "sleep-locations",
      "care-days",
      "api-keys",
      "calendar-feed",
      "data",
    ]);
  });

  it("resolves a section by its URL segment, and refuses an unknown one", () => {
    expect(familySection("care-days", false)?.label).toBe(
      "Days at home with a sick child",
    );
    expect(familySection("nonsense", true)).toBeUndefined();
  });

  it("does not hand an admin-only section to a member who typed the URL", () => {
    expect(familySection("api-keys", false)).toBeUndefined();
    expect(familySection("api-keys", true)?.key).toBe("api-keys");
  });
});
