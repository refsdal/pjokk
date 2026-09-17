import { describe, expect, it } from "bun:test";
import type { TimelineEntry } from "@pjokk/shared";
import {
  daySummary,
  entryMain,
  groupByDay,
} from "../src/components/TimelineList";

// The grouping and the day line used to be private to the Timeline screen;
// Home's Recent pane (spec §4) renders the same list, so they moved to the
// shared component and get pinned here.
const feed = (time: string): TimelineEntry =>
  ({
    kind: "feed",
    id: `f-${time}`,
    time,
    type: "bottle",
    amountMl: 100,
    side: null,
    durationMin: null,
    contents: null,
    food: null,
    reaction: null,
    notes: null,
    caretakerId: "u1",
    caretakerName: "Anders",
  }) as unknown as TimelineEntry;
const sleep = (
  startTime: string,
  endTime: string | null,
  type: "nap" | "night" | null = "nap",
): TimelineEntry =>
  ({
    kind: "sleep",
    id: `s-${startTime}`,
    startTime,
    endTime,
    location: null,
    type,
    notes: null,
    caretakerId: "u1",
    caretakerName: "Anders",
  }) as unknown as TimelineEntry;

describe("groupByDay", () => {
  it("groups consecutive entries by local day, sessions by their start", () => {
    const groups = groupByDay([
      feed("2026-09-08T12:48:00"),
      sleep("2026-09-08T10:52:00", "2026-09-08T11:37:00"),
      feed("2026-09-07T21:45:00"),
    ]);
    expect(groups.map((g) => g.entries.length)).toEqual([2, 1]);
    expect(groups[0]!.date.getDate()).toBe(8);
    expect(groups[1]!.date.getDate()).toBe(7);
  });
});

describe("daySummary", () => {
  it("counts feeds, naps and diapers and leaves out zeros", () => {
    expect(
      daySummary([
        feed("2026-09-08T12:48:00"),
        feed("2026-09-08T09:15:00"),
        sleep("2026-09-08T10:52:00", "2026-09-08T11:37:00"),
      ]),
    ).toBe("2 feeds · 1 nap");
  });

  it("gives a night its own part, never counting it as a nap or as other", () => {
    expect(
      daySummary([
        feed("2026-09-08T12:48:00"),
        sleep("2026-09-08T10:52:00", "2026-09-08T11:37:00"),
        sleep("2026-09-08T08:00:00", "2026-09-08T08:30:00", null),
        sleep("2026-09-07T19:30:00", "2026-09-08T06:30:00", "night"),
      ]),
    ).toBe("1 feed · 2 naps · 1 night");
  });
});

// A day at barnehage (issue #105) is a session row: grouped by its start,
// read as a span, with the pick-up person last, where a narrow row cuts.
describe("a daycare day", () => {
  const day = (endTime: string | null, pickup: string | null): TimelineEntry =>
    ({
      kind: "daycare",
      id: "d1",
      startTime: "2026-09-08T08:10:00",
      endTime,
      pickupCaretakerId: pickup ? "u2" : null,
      pickupCaretakerName: pickup,
      notes: null,
      caretakerId: "u1",
      caretakerName: "Kari",
    }) as unknown as TimelineEntry;

  it("groups under the day it started", () => {
    const groups = groupByDay([
      feed("2026-09-08T17:00:00"),
      day("2026-09-08T15:40:00", "Anders"),
    ]);
    expect(groups.map((g) => g.entries.length)).toEqual([2]);
  });

  it("reads as a span with a duration and who picked up", () => {
    expect(entryMain(day("2026-09-08T15:40:00", "Anders"), "metric")).toEqual({
      title: "Daycare",
      detail: "08:10–15:40 · 7:30 · picked up by Anders",
    });
  });

  it("leaves the pick-up person out when nobody recorded one", () => {
    expect(entryMain(day("2026-09-08T15:40:00", null), "metric").detail).toBe(
      "08:10–15:40 · 7:30",
    );
  });

  it("says since when she is still there", () => {
    expect(entryMain(day(null, null), "metric").detail).toBe("since 08:10");
  });
});
