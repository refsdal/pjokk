import { describe, expect, it } from "bun:test";
import type { MedicineCatalogueEntry } from "@pjokk/shared";
import {
  medicineSheetFilename,
  medicineSheetRows,
} from "../src/lib/medicine-sheet";
import { DAYS_FRIDAY, SPARES_PRESET, daysLabel } from "../src/lib/reminder-ui";

// The barnehage small items (issue #113).
const entry = (over: Partial<MedicineCatalogueEntry>): MedicineCatalogueEntry =>
  ({
    id: "m",
    name: "Paracet",
    defaultAmount: null,
    unit: null,
    minIntervalMin: null,
    isSupplement: false,
    archived: false,
    lastDoseAt: null,
    ...over,
  }) as MedicineCatalogueEntry;
const t = (s: string) => s;

describe("medicineSheetRows", () => {
  it("prints the family's own entries, and only the live ones", () => {
    const rows = medicineSheetRows(
      [
        entry({
          name: "Paracet",
          defaultAmount: 2.5,
          unit: "ml",
          minIntervalMin: 360,
        }),
        entry({
          name: "D-vitamin",
          isSupplement: true,
          defaultAmount: 5,
          unit: "drops",
        }),
        entry({ name: "Old syrup", archived: true }),
        entry({ name: "Saltvann" }),
      ],
      t,
    );
    expect(rows.map((r) => r.name)).toEqual([
      "Paracet",
      "D-vitamin (supplement)",
      "Saltvann",
    ]);
    expect(rows[0]!.dose).toBe("2.5 ml");
    expect(rows[0]!.interval).toContain("at least");
    // Nothing invented where the family typed nothing.
    expect(rows[2]).toEqual({ name: "Saltvann", dose: "", interval: "" });
  });

  it("names the file after the baby, ASCII-safe", () => {
    expect(medicineSheetFilename("Bjørn Åge")).toBe(
      "pjokk-bjorn-age-medicines.pdf",
    );
  });
});

describe("the spare-clothes preset", () => {
  it("is an ordinary custom reminder on Fridays", () => {
    expect(SPARES_PRESET.days).toBe(DAYS_FRIDAY);
    expect(daysLabel(DAYS_FRIDAY)).toBe("Fri");
    expect(SPARES_PRESET.atTime).toBe("15:00");
  });
});
