import { describe, expect, it } from "bun:test";
import {
  clockLines,
  illnessClock,
  illnessDays,
  lastSymptom,
  suggestedClearHours,
  symptomsLine,
} from "../src/lib/illness-ui";

// The symptom-free clock (issue #107): a moment and the family's own number
// of hours. The arithmetic is the feature, so it is pinned here.
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m);
const iso = (d: number, h: number, m = 0) => at(d, h, m).toISOString();
const temp = (value: number, time: string) => ({
  type: "temperature",
  value,
  time,
});

describe("suggestedClearHours", () => {
  it("opens on FHI's 48 h for vomiting or diarrhoea, and on nothing else", () => {
    expect(suggestedClearHours(["vomiting"])).toBe(48);
    expect(suggestedClearHours(["fever", "diarrhoea"])).toBe(48);
    expect(suggestedClearHours(["fever", "cough"])).toBeNull();
    expect(suggestedClearHours([])).toBeNull();
  });
});

describe("lastSymptom", () => {
  it("is null while nobody has said she is symptom-free", () => {
    expect(
      lastSymptom({ lastSymptomAt: null }, [temp(39.1, iso(8, 9))]),
    ).toBeNull();
  });

  it("moves past a fever logged after it, and only a fever", () => {
    const ill = { lastSymptomAt: iso(8, 14, 20) };
    expect(lastSymptom(ill, [])).toEqual(at(8, 14, 20));
    expect(lastSymptom(ill, [temp(37.4, iso(8, 20))])).toEqual(at(8, 14, 20));
    expect(
      lastSymptom(ill, [temp(38.0, iso(8, 20)), temp(38.6, iso(9, 3))]),
    ).toEqual(at(9, 3));
    // An earlier fever is already behind the moment the family gave.
    expect(lastSymptom(ill, [temp(39.0, iso(8, 9))])).toEqual(at(8, 14, 20));
    // A weight of 38 is not a fever.
    expect(
      lastSymptom(ill, [{ type: "weight", value: 38, time: iso(9, 3) }]),
    ).toEqual(at(8, 14, 20));
  });
});

describe("illnessClock", () => {
  const ill = { lastSymptomAt: iso(8, 14, 20), clearHours: 48 };

  it("counts to the family's hours, then says they have passed", () => {
    const before = illnessClock(ill, [], at(9, 10));
    expect(before).toEqual({
      state: "counting",
      since: at(8, 14, 20),
      hours: 48,
      at: at(10, 14, 20),
    });
    expect(illnessClock(ill, [], at(10, 14, 19)).state).toBe("counting");
    expect(illnessClock(ill, [], at(10, 14, 20)).state).toBe("passed");
  });

  it("restarts from a later fever", () => {
    const c = illnessClock(ill, [temp(38.4, iso(9, 6))], at(10, 15));
    expect(c).toEqual({
      state: "counting",
      since: at(9, 6),
      hours: 48,
      at: at(11, 6),
    });
  });

  it("has no clock without a number, and none while she has symptoms", () => {
    expect(
      illnessClock(
        { lastSymptomAt: iso(8, 14, 20), clearHours: null },
        [],
        at(12, 0),
      ),
    ).toEqual({
      state: "free",
      since: at(8, 14, 20),
    });
    expect(illnessClock({ lastSymptomAt: null, clearHours: 48 }).state).toBe(
      "symptoms",
    );
  });
});

describe("the card's words", () => {
  it("never says she may return: a moment, and hours measured from it", () => {
    const ill = { lastSymptomAt: iso(8, 14, 20), clearHours: 48 };
    const now = at(9, 10);
    const counting = clockLines(illnessClock(ill, [], now), now);
    // One fact per line, so the moment the hours are reached is never the
    // truncated tail of a long one.
    expect(counting).toHaveLength(2);
    expect(counting[0]).toBe("Symptom-free since Yesterday 14:20");
    expect(counting[1]!.startsWith("48 h on ")).toBe(true);
    expect(counting[1]!.endsWith(" 14:20")).toBe(true);
    const later = at(10, 16);
    expect(clockLines(illnessClock(ill, [], later), later)).toEqual([
      "48 h symptom-free since Today 14:20",
    ]);
    expect(clockLines({ state: "symptoms" })).toEqual(["Still has symptoms"]);
    for (const word of ["may", "can", "return", "ready"]) {
      expect(counting.join(" ").toLowerCase().split(/\W+/)).not.toContain(word);
    }
  });

  it("lists symptoms lowercase, in the order given", () => {
    expect(symptomsLine(["vomiting", "fever"])).toBe("vomiting · fever");
  });

  it("counts an episode in whole days, at least one", () => {
    expect(illnessDays({ startTime: iso(8, 8), endTime: iso(8, 15) })).toBe(1);
    expect(illnessDays({ startTime: iso(8, 8), endTime: iso(10, 14) })).toBe(2);
    expect(
      illnessDays({ startTime: iso(8, 8), endTime: null }, at(11, 9)),
    ).toBe(3);
  });
});
