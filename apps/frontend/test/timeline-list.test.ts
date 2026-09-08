import { describe, expect, it } from "bun:test";
import type { TimelineEntry } from "@pjokk/shared";
import { daySummary, groupByDay } from "../src/components/TimelineList";

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
const sleep = (startTime: string, endTime: string | null): TimelineEntry =>
  ({
    kind: "sleep",
    id: `s-${startTime}`,
    startTime,
    endTime,
    location: null,
    type: "nap",
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
});
