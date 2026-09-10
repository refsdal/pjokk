import { describe, expect, test } from "bun:test";
import type { SleepLog } from "@pjokk/shared";
import {
  RESUME_WINDOW_MS,
  canResumeEdit,
  resumableSleep,
} from "../src/lib/sleep-resume";

const now = new Date("2026-09-10T03:00:00Z");
const minAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

const sleep = (over: Partial<SleepLog> = {}): SleepLog => ({
  id: "s1",
  babyId: "b1",
  caretakerId: "u1",
  caretakerName: "Kari",
  startTime: minAgo(120),
  endTime: minAgo(5),
  location: null,
  type: "night",
  notes: null,
  ...over,
});

describe("resumableSleep", () => {
  test("the last sleep, while it ended inside the window", () => {
    const last = sleep();
    expect(resumableSleep({ activeSleep: null, lastSleep: last }, now)).toBe(
      last,
    );
  });

  test("the window's edge is inclusive; a minute past it is not", () => {
    const edge = sleep({
      endTime: new Date(now.getTime() - RESUME_WINDOW_MS).toISOString(),
    });
    expect(resumableSleep({ activeSleep: null, lastSleep: edge }, now)).toBe(
      edge,
    );
    const past = sleep({ endTime: minAgo(RESUME_WINDOW_MS / 60_000 + 1) });
    expect(
      resumableSleep({ activeSleep: null, lastSleep: past }, now),
    ).toBeNull();
  });

  test("a wake stamped slightly ahead of this device's clock still counts", () => {
    const skewed = sleep({ endTime: minAgo(-1) });
    expect(resumableSleep({ activeSleep: null, lastSleep: skewed }, now)).toBe(
      skewed,
    );
  });

  test("nothing while a sleep is running", () => {
    const running = sleep({ id: "s2", endTime: null, startTime: minAgo(2) });
    expect(
      resumableSleep({ activeSleep: running, lastSleep: running }, now),
    ).toBeNull();
    // Even when the summary's last sleep is an older, finished one.
    expect(
      resumableSleep({ activeSleep: running, lastSleep: sleep() }, now),
    ).toBeNull();
  });

  test("nothing without a finished last sleep or a summary", () => {
    expect(
      resumableSleep({ activeSleep: null, lastSleep: null }, now),
    ).toBeNull();
    expect(
      resumableSleep(
        { activeSleep: null, lastSleep: sleep({ endTime: null }) },
        now,
      ),
    ).toBeNull();
    expect(resumableSleep(undefined, now)).toBeNull();
  });
});

describe("canResumeEdit", () => {
  test("the newest finished sleep, however long ago it ended", () => {
    const last = sleep({ endTime: minAgo(600) });
    expect(canResumeEdit(last, { activeSleep: null, lastSleep: last })).toBe(
      true,
    );
  });

  test("never an older sleep: reopening it would overlap the newer one", () => {
    const older = sleep({ id: "old" });
    expect(
      canResumeEdit(older, { activeSleep: null, lastSleep: sleep() }),
    ).toBe(false);
  });

  test("never while a sleep is running, and never the running one itself", () => {
    const running = sleep({ id: "s2", endTime: null });
    expect(
      canResumeEdit(sleep(), { activeSleep: running, lastSleep: sleep() }),
    ).toBe(false);
    expect(
      canResumeEdit(running, { activeSleep: null, lastSleep: running }),
    ).toBe(false);
  });

  test("never without a summary to check against", () => {
    expect(canResumeEdit(sleep(), undefined)).toBe(false);
  });
});
