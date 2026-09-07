import { describe, expect, test } from "bun:test";
import {
  medicineDetail,
  medicineIntervalLabel,
  nextDoseFrom,
} from "../src/lib/medicine-ui";

describe("nextDoseFrom", () => {
  const now = new Date("2026-03-16T12:00:00Z");
  const base = { minIntervalMin: 360, isSupplement: false };

  test("adds the family's interval to the last dose while it is still ahead", () => {
    const at = nextDoseFrom(
      { ...base, lastDoseAt: "2026-03-16T09:00:00Z" },
      now,
    );
    expect(at?.toISOString()).toBe("2026-03-16T15:00:00.000Z");
  });

  test("is null once the interval has passed", () => {
    expect(
      nextDoseFrom({ ...base, lastDoseAt: "2026-03-16T05:00:00Z" }, now),
    ).toBeNull();
  });

  test("is null with no interval, no dose, or for a supplement", () => {
    expect(
      nextDoseFrom(
        { ...base, minIntervalMin: null, lastDoseAt: "2026-03-16T11:00:00Z" },
        now,
      ),
    ).toBeNull();
    expect(nextDoseFrom({ ...base, lastDoseAt: null }, now)).toBeNull();
    expect(
      nextDoseFrom(
        { ...base, isSupplement: true, lastDoseAt: "2026-03-16T11:00:00Z" },
        now,
      ),
    ).toBeNull();
  });
});

describe("labels", () => {
  test("interval labels", () => {
    expect(medicineIntervalLabel(240)).toBe("4 h");
    expect(medicineIntervalLabel(1440)).toBe("1 d");
    expect(medicineIntervalLabel(90)).toBe("1 h 30 min");
    expect(medicineIntervalLabel(45)).toBe("45 min");
  });

  test("row detail joins what is set", () => {
    expect(
      medicineDetail({
        id: "m",
        name: "Paracetamol",
        defaultAmount: 2.5,
        unit: "ml",
        minIntervalMin: 360,
        isSupplement: false,
        archived: false,
        lastDoseAt: null,
      }),
    ).toBe("2.5 ml · every 6 h");
    expect(
      medicineDetail({
        id: "v",
        name: "Vitamin D",
        defaultAmount: null,
        unit: null,
        minIntervalMin: null,
        isSupplement: true,
        archived: true,
        lastDoseAt: null,
      }),
    ).toBe("supplement · archived");
  });
});
