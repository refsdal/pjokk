import { describe, expect, test } from "bun:test";
import type { FeedTimer } from "@pjokk/shared";
import {
  clock,
  minutesFromSeconds,
  sideSeconds,
  totalSeconds,
} from "../src/lib/feed-timer-ui";

const t0 = Date.parse("2026-03-15T09:00:00Z");
const timer = (over: Partial<FeedTimer>): FeedTimer => ({
  id: "t1",
  babyId: "b",
  caretakerId: "u",
  caretakerName: "Anders",
  kind: "breast",
  startTime: new Date(t0).toISOString(),
  runningSide: "left",
  sideStartedAt: new Date(t0).toISOString(),
  leftSec: 0,
  rightSec: 0,
  ...over,
});

describe("sideSeconds", () => {
  test("the running side adds the stretch since sideStartedAt", () => {
    const tm = timer({ leftSec: 120, rightSec: 30, runningSide: "left" });
    expect(sideSeconds(tm, "left", t0 + 45_000)).toBe(165);
    expect(sideSeconds(tm, "right", t0 + 45_000)).toBe(30);
  });

  test("paused: only what was banked", () => {
    const tm = timer({
      leftSec: 120,
      rightSec: 30,
      runningSide: null,
      sideStartedAt: null,
    });
    expect(sideSeconds(tm, "left", t0 + 45_000)).toBe(120);
    expect(sideSeconds(tm, "right", t0 + 45_000)).toBe(30);
  });

  test("a pump timer (side both) banks into left, like the server", () => {
    const tm = timer({ kind: "pump", runningSide: "both" });
    expect(sideSeconds(tm, "left", t0 + 600_000)).toBe(600);
    expect(sideSeconds(tm, "right", t0 + 600_000)).toBe(0);
    expect(totalSeconds(tm, t0 + 600_000)).toBe(600);
  });

  test("a clock that is behind the server never goes negative", () => {
    const tm = timer({ leftSec: 10 });
    expect(sideSeconds(tm, "left", t0 - 5_000)).toBe(10);
  });
});

describe("minutesFromSeconds", () => {
  test("nothing is 0, anything is at least 1, otherwise nearest minute", () => {
    expect(minutesFromSeconds(0)).toBe(0);
    expect(minutesFromSeconds(20)).toBe(1);
    expect(minutesFromSeconds(89)).toBe(1);
    expect(minutesFromSeconds(90)).toBe(2);
    expect(minutesFromSeconds(300)).toBe(5);
  });
});

describe("clock", () => {
  test("mm:ss, zero-padded", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(65)).toBe("01:05");
    expect(clock(3599)).toBe("59:59");
  });
});
