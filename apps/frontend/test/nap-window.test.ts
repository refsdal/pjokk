import { describe, expect, test } from "bun:test";
import {
  describeNapWindow,
  napWindow,
  wakeWindowFor,
  describeUsualNap,
  usualNap,
} from "../src/lib/nap-window";

const min = (n: number) => n * 60_000;
const at = (base: Date, m: number) => new Date(base.getTime() + min(m));

describe("wakeWindowFor", () => {
  test("the cited rows, by month bound", () => {
    expect(wakeWindowFor(0)).toEqual({ minMin: 30, maxMin: 60 });
    expect(wakeWindowFor(0.9)).toEqual({ minMin: 30, maxMin: 60 });
    expect(wakeWindowFor(1)).toEqual({ minMin: 60, maxMin: 120 });
    expect(wakeWindowFor(4.5)).toEqual({ minMin: 75, maxMin: 150 });
    expect(wakeWindowFor(6)).toEqual({ minMin: 120, maxMin: 240 });
    expect(wakeWindowFor(8)).toEqual({ minMin: 150, maxMin: 270 });
    expect(wakeWindowFor(11.5)).toEqual({ minMin: 180, maxMin: 360 });
    expect(wakeWindowFor(12)).toEqual({ minMin: 180, maxMin: 360 });
  });

  test("nothing before birth or past the table", () => {
    expect(wakeWindowFor(-1)).toBeNull();
    expect(wakeWindowFor(12.1)).toBeNull();
    expect(wakeWindowFor(20)).toBeNull();
  });
});

describe("napWindow", () => {
  const now = new Date("2026-09-15T12:00:00");
  const threeMonths = new Date("2026-06-15T00:00:00"); // 75–150 min

  test("upcoming, open, past — from the same wake", () => {
    const wake = at(now, -20);
    const w = napWindow({ birthDate: threeMonths, wakeAt: wake, now });
    expect(w).not.toBeNull();
    expect(w!.state).toBe("upcoming");
    expect(w!.from.getTime()).toBe(at(wake, 75).getTime());
    expect(w!.to.getTime()).toBe(at(wake, 150).getTime());

    expect(
      napWindow({ birthDate: threeMonths, wakeAt: at(now, -100), now })!.state,
    ).toBe("open");
    expect(
      napWindow({ birthDate: threeMonths, wakeAt: at(now, -150), now })!.state,
    ).toBe("open");
    expect(
      napWindow({ birthDate: threeMonths, wakeAt: at(now, -151), now })!.state,
    ).toBe("past");
  });

  test("says nothing without a birth date, a wake, or with a stale wake", () => {
    expect(
      napWindow({ birthDate: null, wakeAt: at(now, -20), now }),
    ).toBeNull();
    expect(napWindow({ birthDate: threeMonths, wakeAt: null, now })).toBeNull();
    expect(
      napWindow({ birthDate: threeMonths, wakeAt: at(now, -13 * 60), now }),
    ).toBeNull();
    // A wake logged in the future (clock skew, a typo) is not a reading.
    expect(
      napWindow({ birthDate: threeMonths, wakeAt: at(now, 5), now }),
    ).toBeNull();
  });

  test("nothing past the table's last row", () => {
    const fourteenMonths = new Date("2025-07-15T00:00:00");
    expect(
      napWindow({ birthDate: fourteenMonths, wakeAt: at(now, -20), now }),
    ).toBeNull();
  });
});

describe("describeNapWindow", () => {
  const now = new Date("2026-09-15T12:00:00");
  const threeMonths = new Date("2026-06-15T00:00:00");
  test("the three lines", () => {
    expect(
      describeNapWindow(
        napWindow({ birthDate: threeMonths, wakeAt: at(now, -20), now })!,
      ),
    ).toBe("Nap window 12:55–14:10");
    expect(
      describeNapWindow(
        napWindow({ birthDate: threeMonths, wakeAt: at(now, -100), now })!,
      ),
    ).toBe("In the nap window · until 12:50");
    expect(
      describeNapWindow(
        napWindow({ birthDate: threeMonths, wakeAt: at(now, -200), now })!,
      ),
    ).toBe("Past the usual nap window");
  });
});

// The family's own anchor (issue #112): past twelve months the cited table
// stops, and a barnehage's fixed nap sets the rhythm.
describe("usualNap", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 19, h, m); // a Saturday
  const minute = 11 * 60 + 30;

  test("says the usual time while it is ahead, then that it was", () => {
    expect(usualNap({ minute, lastSleepStart: null, now: at(9) })).toEqual({
      state: "upcoming",
      at: at(11, 30),
    });
    expect(
      usualNap({ minute, lastSleepStart: null, now: at(12, 15) })?.state,
    ).toBe("was");
    expect(describeUsualNap({ state: "upcoming", at: at(11, 30) })).toBe(
      "Usual nap 11:30",
    );
    expect(describeUsualNap({ state: "was", at: at(11, 30) })).toBe(
      "Usual nap was 11:30",
    );
  });

  test("goes quiet once she has had it: a sleep that began around or after the time", () => {
    expect(
      usualNap({ minute, lastSleepStart: at(11, 10), now: at(13) }),
    ).toBeNull();
    expect(
      usualNap({ minute, lastSleepStart: at(10, 5), now: at(13) }),
    ).toBeNull();
    // The night she woke from this morning is not the nap.
    const lastNight = new Date(2026, 8, 18, 19, 0);
    expect(
      usualNap({ minute, lastSleepStart: lastNight, now: at(9) })?.state,
    ).toBe("upcoming");
    // An early catnap at 08:30 is not it either.
    expect(
      usualNap({ minute, lastSleepStart: at(8, 30), now: at(10) })?.state,
    ).toBe("upcoming");
  });

  test("stops saying it three hours on, and says nothing with no anchor", () => {
    expect(
      usualNap({ minute, lastSleepStart: null, now: at(14, 29) })?.state,
    ).toBe("was");
    expect(
      usualNap({ minute, lastSleepStart: null, now: at(14, 31) }),
    ).toBeNull();
    expect(
      usualNap({ minute: null, lastSleepStart: null, now: at(9) }),
    ).toBeNull();
    expect(
      usualNap({ minute: undefined, lastSleepStart: null, now: at(9) }),
    ).toBeNull();
  });
});
