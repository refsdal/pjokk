import { describe, expect, it } from "bun:test";
import type { Baby } from "@pjokk/shared";
import { features } from "@pjokk/shared";
import {
  ageMonths,
  enabledLabels,
  familyTracks,
  featureCards,
  featureCatalogue,
  logParamFeature,
  otherKindFeature,
  recommended,
  reminderKindFeature,
  tracking,
} from "../src/lib/tracking";

// The per-baby tracking switches (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md).

const baby = (f: Baby["features"]): Baby => ({
  id: "b1",
  name: "Ida",
  birthDate: "2026-06-15T00:00:00.000Z",
  sex: null,
  avatarUrl: null,
  features: f,
});

describe("featureCatalogue", () => {
  it("lists every spec key once, in the spec's order", () => {
    expect(featureCatalogue.map((f) => f.key)).toEqual([...features]);
  });
  it("carries a label, a description, a group, a tint and an icon for each", () => {
    for (const f of featureCatalogue) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(["everyday", "health", "daycare", "extras"]).toContain(f.group);
      expect(f.tint.startsWith("text-")).toBe(true);
      expect(typeof f.icon).toBe("object");
    }
  });
  it("orders the cards Everyday, Health, Barnehage, Extras", () => {
    expect(featureCards.map((f) => f.key)).toEqual([
      "feeds",
      "pump",
      "sleep",
      "diapers",
      "medicine",
      "measurements",
      "illness",
      "vaccines",
      "daycare",
      "milestones",
      "bath",
      "notes",
      "play",
    ]);
  });
});

describe("ageMonths", () => {
  const born = new Date(2026, 5, 15); // 15 June 2026, local
  it("counts whole calendar months", () => {
    expect(ageMonths(born, new Date(2026, 6, 14))).toBe(0);
    expect(ageMonths(born, new Date(2026, 6, 15))).toBe(1);
    expect(ageMonths(born, new Date(2026, 9, 14))).toBe(3);
    expect(ageMonths(born, new Date(2026, 9, 15))).toBe(4);
    expect(ageMonths(born, new Date(2027, 5, 15))).toBe(12);
  });
});

describe("recommended", () => {
  it("under four months: the newborn set", () => {
    expect(recommended(0)).toEqual([
      "feeds",
      "sleep",
      "diapers",
      "measurements",
    ]);
    expect(recommended(3)).toEqual([
      "feeds",
      "sleep",
      "diapers",
      "measurements",
    ]);
  });
  it("four to twelve months adds milestones and play", () => {
    const band: Baby["features"] = [
      "feeds",
      "sleep",
      "diapers",
      "measurements",
      "milestones",
      "play",
    ];
    expect(recommended(4)).toEqual(band);
    expect(recommended(11)).toEqual(band);
  });
  it("twelve months and up drops feeds, keeps diapers, adds medicine and illness — never daycare", () => {
    expect(recommended(12)).toEqual([
      "sleep",
      "diapers",
      "medicine",
      "illness",
    ]);
    expect(recommended(30)).toEqual([
      "sleep",
      "diapers",
      "medicine",
      "illness",
    ]);
  });
  it("never recommends pump, daycare, vaccines, bath or notes at any age", () => {
    for (const m of [0, 4, 12, 36]) {
      for (const k of ["pump", "daycare", "vaccines", "bath", "notes"]) {
        expect(recommended(m)).not.toContain(k);
      }
    }
  });
});

describe("tracking", () => {
  it("answers has(), any and anyMore from the baby's set", () => {
    const t = tracking(baby(["feeds", "sleep"]));
    expect(t.has("feeds")).toBe(true);
    expect(t.has("bath")).toBe(false);
    expect(t.any).toBe(true);
    expect(t.anyMore).toBe(false);
    expect(tracking(baby(["feeds", "medicine"])).anyMore).toBe(true);
  });
  it("is all-off for no baby or an empty set", () => {
    expect(tracking(undefined).any).toBe(false);
    expect(tracking(baby([])).any).toBe(false);
  });
  it("familyTracks is any baby, and true while the list is unknown", () => {
    expect(familyTracks([baby(["sleep"]), baby(["daycare"])], "daycare")).toBe(
      true,
    );
    expect(familyTracks([baby(["sleep"])], "daycare")).toBe(false);
    expect(familyTracks(undefined, "daycare")).toBe(true);
    expect(familyTracks([], "daycare")).toBe(false);
  });
});

describe("kind maps", () => {
  it("maps More kinds, reminder kinds and ?log= values onto switches", () => {
    expect(otherKindFeature("note")).toBe("notes");
    expect(otherKindFeature("measurement")).toBe("measurements");
    expect(otherKindFeature("milestone")).toBe("milestones");
    expect(otherKindFeature("pump")).toBe("pump");
    expect(reminderKindFeature("feed")).toBe("feeds");
    expect(reminderKindFeature("custom")).toBeNull();
    expect(logParamFeature("feed")).toBe("feeds");
    expect(logParamFeature("diaper")).toBe("diapers");
    expect(logParamFeature("sleep")).toBe("sleep");
    expect(logParamFeature("medicine")).toBe("medicine");
    expect(logParamFeature("nonsense")).toBeNull();
  });
  it("enabledLabels reads in catalogue order", () => {
    expect(enabledLabels(baby(["diapers", "feeds"]))).toEqual([
      "Feeds",
      "Diapers",
    ]);
  });
});
