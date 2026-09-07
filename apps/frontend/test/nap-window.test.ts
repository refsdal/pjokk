import { describe, expect, test } from "bun:test";
import {
  describeNapWindow,
  napWindow,
  wakeWindowFor,
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
