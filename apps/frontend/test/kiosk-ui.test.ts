import { describe, expect, it } from "bun:test";
import type { FeedLog, MedicineCatalogueEntry, SleepLog } from "@pjokk/shared";
import {
  cautionFor,
  feedCardView,
  lastBottle,
  medicineStripView,
  pinPadReducer,
  sleepCardView,
  totalsLines,
  undoText,
} from "../src/lib/kiosk-ui";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-08T14:20:00");

describe("cautionFor (spec §4)", () => {
  const feed3h = {
    kind: "feed",
    mode: "since_last",
    intervalMin: 180,
    babyId: null,
  };
  it("is off without a reminder", () => {
    expect(cautionFor("feed", at("2026-09-08T10:00:00"), [], "b1", NOW)).toBe(
      false,
    );
  });
  it("turns on once the interval has elapsed", () => {
    // 179 min
    expect(
      cautionFor("feed", at("2026-09-08T11:21:00"), [feed3h], "b1", NOW),
    ).toBe(false);
    // 181 min
    expect(
      cautionFor("feed", at("2026-09-08T11:19:00"), [feed3h], "b1", NOW),
    ).toBe(true);
  });
  it("ignores other kinds, at_time reminders and other babies", () => {
    const old = at("2026-09-08T09:00:00");
    expect(cautionFor("diaper", old, [feed3h], "b1", NOW)).toBe(false);
    expect(
      cautionFor("feed", old, [{ ...feed3h, mode: "at_time" }], "b1", NOW),
    ).toBe(false);
    expect(
      cautionFor("feed", old, [{ ...feed3h, babyId: "b2" }], "b1", NOW),
    ).toBe(false);
    expect(
      cautionFor("feed", old, [{ ...feed3h, babyId: "b1" }], "b1", NOW),
    ).toBe(true);
  });
  it("is off with nothing logged yet", () => {
    expect(cautionFor("feed", null, [feed3h], "b1", NOW)).toBe(false);
  });
});

describe("totalsLines", () => {
  it("renders the two band lines", () => {
    expect(
      totalsLines(
        {
          feeds: 6,
          intakeMl: 640,
          solidsG: 0,
          wet: 3,
          dirty: 1,
          both: 1,
          dry: 0,
          sleepMin: 125,
          sleeps: 2,
        },
        "metric",
      ),
    ).toEqual(["6 feeds · 640 ml", "5 diapers · 2 h 5 min sleep"]);
  });
});

const sleep = (
  startTime: string,
  endTime: string | null,
  location = "crib",
): SleepLog =>
  ({
    id: "s1",
    babyId: "b1",
    caretakerId: "u1",
    caretakerName: "A",
    startTime,
    endTime,
    location,
    type: "nap",
    notes: null,
  }) as unknown as SleepLog;

describe("sleepCardView", () => {
  it("reads awake time from the last sleep's end", () => {
    const v = sleepCardView(
      {
        activeSleep: null,
        lastSleep: sleep("2026-09-08T12:25:00", "2026-09-08T13:10:00"),
      },
      NOW,
    );
    expect(v.state).toBe("awake");
    expect(v.headline).toBe("1 h 10 min");
    expect(v.detail).toContain("45 min");
    expect(v.detail).toContain("crib");
  });
  it("reads the running session while sleeping", () => {
    const v = sleepCardView(
      { activeSleep: sleep("2026-09-08T13:35:00", null), lastSleep: null },
      NOW,
    );
    expect(v.state).toBe("sleeping");
    expect(v.headline).toBe("45 min");
    expect(v.detail).toContain("13:35");
  });
  it("copes with nothing logged", () => {
    expect(
      sleepCardView({ activeSleep: null, lastSleep: null }, NOW).state,
    ).toBe("none");
  });
});

const feed = (
  time: string,
  amountMl: number,
  contents: "formula" | null = "formula",
): FeedLog =>
  ({
    id: "f1",
    babyId: "b1",
    caretakerId: "u1",
    caretakerName: "A",
    time,
    type: "bottle",
    amountMl,
    side: null,
    durationMin: null,
    contents,
    food: null,
    reaction: null,
    notes: null,
  }) as unknown as FeedLog;

describe("feedCardView / lastBottle", () => {
  it("shows the last feed as elapsed + amount", () => {
    const v = feedCardView(
      { lastFeed: feed("2026-09-08T12:48:00", 120), activeFeed: null },
      "metric",
      NOW,
    );
    expect(v.live).toBe(false);
    expect(v.headline).toBe("1 h 32 min");
    expect(v.detail).toContain("120 ml");
  });
  it("prefers the last bottle for the quick action, defaulting to 120", () => {
    expect(lastBottle([feed("2026-09-08T12:48:00", 90, null)])).toEqual({
      amountMl: 90,
      contents: null,
    });
    expect(lastBottle([])).toEqual({ amountMl: 120, contents: null });
  });
});

const entry = (
  lastDoseAt: string | null,
  minIntervalMin: number | null,
): MedicineCatalogueEntry => ({
  id: "m1",
  name: "Paracetamol",
  defaultAmount: 2.5,
  unit: "ml",
  minIntervalMin,
  isSupplement: false,
  archived: false,
  lastDoseAt,
});

describe("medicineStripView (spec §5)", () => {
  it("shows a dose whose interval is still running, with 'OK from'", () => {
    const v = medicineStripView(entry("2026-09-08T11:40:00", 240), NOW);
    expect(v.show).toBe(true);
    expect(v.ahead).toBe(true);
    expect(v.okText).toBe("OK from 15:40");
  });
  it("shows a dose from the last 24 h even once the interval passed, with 'OK now'", () => {
    const v = medicineStripView(entry("2026-09-08T08:00:00", 240), NOW);
    expect(v.show).toBe(true);
    expect(v.ahead).toBe(false);
    expect(v.okText).toBe("OK now");
  });
  it("hides an entry with no dose in the last 24 h", () => {
    expect(medicineStripView(entry("2026-09-06T08:00:00", 240), NOW).show).toBe(
      false,
    );
    expect(medicineStripView(entry(null, 240), NOW).show).toBe(false);
  });
});

describe("undoText", () => {
  it("names what was logged", () => {
    expect(undoText("diaper", "wet")).toBe("Wet diaper logged");
    expect(undoText("feed", "120 ml")).toBe("Bottle 120 ml logged");
    expect(undoText("sleep")).toBe("Sleep started");
    expect(undoText("medicine", "Paracetamol")).toBe("Paracetamol logged");
  });
});

describe("pinPadReducer (spec §6)", () => {
  const s0 = { digits: "", wrong: 0, error: null };
  it("collects digits up to the length and backspaces", () => {
    let s = pinPadReducer(s0, { type: "digit", d: "1" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "2" }, 4);
    expect(s.digits).toBe("12");
    s = pinPadReducer(s, { type: "backspace" }, 4);
    expect(s.digits).toBe("1");
    s = pinPadReducer(s, { type: "digit", d: "2" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "3" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "4" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "5" }, 4);
    expect(s.digits).toBe("1234");
  });
  it("a wrong PIN clears, counts and shows the message", () => {
    const s = pinPadReducer(
      { digits: "1234", wrong: 1, error: null },
      { type: "wrong" },
      4,
    );
    expect(s).toEqual({ digits: "", wrong: 2, error: "Wrong PIN" });
  });
  it("typing again clears the message", () => {
    const s = pinPadReducer(
      { digits: "", wrong: 2, error: "Wrong PIN" },
      { type: "digit", d: "9" },
      4,
    );
    expect(s.error).toBeNull();
    expect(s.wrong).toBe(2);
  });
});
