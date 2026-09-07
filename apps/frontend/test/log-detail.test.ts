import { describe, expect, test } from "bun:test";
import { diaperDetail, feedDetail, sleepTitle } from "../src/lib/log-detail";
import { sleepTypeAt } from "../src/lib/night";

// The detail line is what a parent scrolls past a hundred times a week; it
// must say exactly what was recorded and nothing for what was not.
describe("feedDetail", () => {
  test("bottle: amount, then contents when recorded", () => {
    expect(feedDetail("120 ml", { type: "bottle", contents: "formula" })).toBe(
      "120 ml · formula",
    );
    expect(feedDetail("120 ml", { type: "bottle", contents: null })).toBe(
      "120 ml",
    );
    expect(
      feedDetail("90 ml", { type: "bottle", contents: "breast_milk" }),
    ).toBe("90 ml · breast milk");
  });

  test("solids: amount, food, reaction flag; a false reaction is silent", () => {
    expect(
      feedDetail("40 g", { type: "solids", food: "Banana", reaction: true }),
    ).toBe("40 g · Banana · reaction");
    expect(
      feedDetail("40 g", { type: "solids", food: "Banana", reaction: false }),
    ).toBe("40 g · Banana");
    expect(feedDetail(null, { type: "solids", food: null })).toBeNull();
  });

  test("contents never leaks onto a solids row, food never onto a bottle", () => {
    expect(
      feedDetail("40 g", { type: "solids", contents: "formula", food: "Pear" }),
    ).toBe("40 g · Pear");
    expect(feedDetail("120 ml", { type: "bottle", food: "Pear" })).toBe(
      "120 ml",
    );
  });
});

describe("diaperDetail", () => {
  test("colour and consistency, either alone, nothing when unrecorded", () => {
    expect(diaperDetail({ color: "green", consistency: "loose" })).toBe(
      "green · loose",
    );
    expect(diaperDetail({ color: "yellow", consistency: null })).toBe("yellow");
    expect(diaperDetail({ color: null, consistency: "firm" })).toBe("firm");
    expect(diaperDetail({})).toBeNull();
  });
});

describe("sleepTitle", () => {
  test("nap / night sleep / plain sleep for untyped rows", () => {
    expect(sleepTitle("nap")).toBe("Nap");
    expect(sleepTitle("night")).toBe("Night sleep");
    expect(sleepTitle(null)).toBe("Sleep");
    expect(sleepTitle(undefined)).toBe("Sleep");
  });
});

describe("sleepTypeAt", () => {
  const schedule = { startHour: 22, endHour: 7 };
  const at = (h: number) => new Date(2026, 2, 15, h, 30);

  test("inside the night window is night, outside is nap", () => {
    expect(sleepTypeAt(at(23), schedule)).toBe("night");
    expect(sleepTypeAt(at(3), schedule)).toBe("night");
    expect(sleepTypeAt(at(13), schedule)).toBe("nap");
    // Boundaries: start hour is in, end hour is out (same rule as night mode).
    expect(sleepTypeAt(at(22), schedule)).toBe("night");
    expect(sleepTypeAt(at(7), schedule)).toBe("nap");
  });

  test("a window that does not cross midnight also works", () => {
    const day = { startHour: 1, endHour: 5 };
    expect(sleepTypeAt(at(3), day)).toBe("night");
    expect(sleepTypeAt(at(23), day)).toBe("nap");
  });
});
