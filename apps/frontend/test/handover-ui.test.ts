import { describe, expect, it } from "bun:test";
import type { Handover } from "@pjokk/shared";
import {
  DEFAULT_NAP,
  clockOf,
  draftFor,
  inDay,
  napIsBackwards,
  napOutsideDay,
  napToAdd,
  onDay,
  toHandover,
} from "../src/lib/handover-ui";

// The pick-up handover's pure half (issue #106): what the sheet opens on,
// and what it saves.
const day = {
  startTime: new Date(2026, 8, 8, 8, 10, 37).toISOString(),
  endTime: new Date(2026, 8, 8, 15, 40).toISOString(),
};
const at = (h: number, m: number) => new Date(2026, 8, 8, h, m).toISOString();
const yesterday = (h: number, m: number) =>
  new Date(2026, 8, 7, h, m).toISOString();
const empty: Handover = {
  naps: [],
  meals: [],
  diapers: { wet: 0, dirty: 0 },
  mood: null,
};

describe("draftFor", () => {
  it("opens a first handover on one usual nap and nothing else", () => {
    const d = draftFor(empty, null, day);
    expect(d.naps).toEqual([DEFAULT_NAP]);
    expect(d.meals.lunch).toMatchObject({
      clock: "11:00",
      appetite: null,
      food: null,
    });
    expect([d.wet, d.dirty, d.mood]).toEqual([0, 0, null]);
  });

  it("carries yesterday's clock times, and none of its observations", () => {
    const previous: Handover = {
      naps: [{ startTime: yesterday(11, 40), endTime: yesterday(13, 10) }],
      meals: [{ time: yesterday(11, 15), appetite: "well", food: "Soup" }],
      diapers: { wet: 3, dirty: 1 },
      mood: "good",
    };
    const d = draftFor(empty, previous, day);
    expect(d.naps).toEqual([{ start: "11:40", end: "13:10" }]);
    expect(d.meals.lunch).toMatchObject({
      clock: "11:15",
      appetite: null,
      food: null,
    });
    expect(d.meals.breakfast.clock).toBe("08:30");
    expect([d.wet, d.dirty, d.mood]).toEqual([0, 0, null]);
  });

  it("opens an edit on exactly what was saved, a no-nap day included", () => {
    const saved: Handover = {
      naps: [],
      meals: [
        { time: at(11, 0), appetite: "little", food: "Fish" },
        { time: at(14, 5), appetite: "well", food: null },
      ],
      diapers: { wet: 2, dirty: 1 },
      mood: "hard",
    };
    const d = draftFor(saved, null, day);
    expect(d.naps).toEqual([]);
    expect(d.meals.lunch).toMatchObject({
      clock: "11:00",
      appetite: "little",
      food: "Fish",
    });
    expect(d.meals.snack.appetite).toBe("well");
    expect(d.meals.breakfast.appetite).toBeNull();
    expect([d.wet, d.dirty, d.mood]).toEqual([2, 1, "hard"]);
  });

  it("keeps a fourth meal it has no slot for", () => {
    const saved: Handover = {
      ...empty,
      meals: [8, 11, 14, 15].map((h) => ({
        time: at(h, 30),
        appetite: "some" as const,
        food: null,
      })),
    };
    const d = draftFor(saved, null, day);
    expect(d.otherMeals).toHaveLength(1);
    expect(toHandover(d, day).meals).toHaveLength(4);
  });
});

describe("toHandover", () => {
  it("writes only the meals someone described, on the day she was there", () => {
    const d = draftFor(empty, null, day);
    d.meals.lunch.appetite = "well";
    d.wet = 3;
    d.mood = "good";
    const h = toHandover(d, day);
    expect(h.meals).toEqual([
      { time: at(11, 0), appetite: "well", food: null },
    ]);
    expect(h.naps).toEqual([{ startTime: at(11, 30), endTime: at(13, 0) }]);
    expect(h.diapers).toEqual({ wet: 3, dirty: 0 });
    expect(h.mood).toBe("good");
  });

  it("drops a nap that ends before it starts rather than send a 400", () => {
    const d = draftFor(empty, null, day);
    d.naps = [{ start: "13:00", end: "11:30" }];
    expect(napIsBackwards(d.naps[0]!)).toBe(true);
    expect(toHandover(d, day).naps).toEqual([]);
  });

  it("round-trips through the clock", () => {
    expect(clockOf(onDay(day, "11:45").toISOString())).toBe("11:45");
  });
});

// The handover is about the hours she was there. Found by looking at an
// e2e screenshot: a day that ended 09:27 had been given the usual 11:30 nap
// and an 11:00 lunch — rows in the future.
describe("the day's edges", () => {
  const early = {
    startTime: new Date(2026, 8, 8, 8, 10, 37).toISOString(),
    endTime: new Date(2026, 8, 8, 12, 5).toISOString(), // fetched with a fever
  };

  it("offers no usual nap, and no snack, after an early pick-up", () => {
    const d = draftFor(empty, null, early);
    expect(d.naps).toEqual([]);
    expect(d.meals.breakfast.offered).toBe(true);
    expect(d.meals.lunch.offered).toBe(true);
    expect(d.meals.snack.offered).toBe(false);
    expect(toHandover(d, early).naps).toEqual([]);
  });

  it("does not offer breakfast to a child dropped off after it", () => {
    const late = {
      ...day,
      startTime: new Date(2026, 8, 8, 9, 15).toISOString(),
    };
    expect(draftFor(empty, null, late).meals.breakfast.offered).toBe(false);
  });

  it("still shows a saved meal whose slot the day no longer covers", () => {
    const saved: Handover = {
      ...empty,
      meals: [{ time: at(14, 0), appetite: "some", food: null }],
    };
    expect(draftFor(saved, null, early).meals.snack.offered).toBe(true);
  });

  it("counts the drop-off minute as inside, seconds and all", () => {
    expect(inDay(day, "08:10")).toBe(true);
    expect(inDay(day, "08:09")).toBe(false);
    expect(inDay(day, "15:40")).toBe(true);
    expect(inDay(day, "15:41")).toBe(false);
  });

  it("measures a running day against now", () => {
    const running = { startTime: day.startTime, endTime: null };
    const noon = new Date(2026, 8, 8, 12, 0);
    expect(napOutsideDay(DEFAULT_NAP, running, noon)).toBe(true);
    expect(napOutsideDay({ start: "09:30", end: "10:15" }, running, noon)).toBe(
      false,
    );
  });

  it("adds the usual nap when it fits, else the end of the day", () => {
    expect(napToAdd(day)).toEqual(DEFAULT_NAP);
    expect(napToAdd(early)).toEqual({ start: "10:35", end: "12:05" });
    expect(napOutsideDay(napToAdd(early), early)).toBe(false);
  });
});
