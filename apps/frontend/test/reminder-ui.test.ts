import { describe, expect, test } from "bun:test";
import type { Reminder } from "../src/lib/data/reminders";
import {
  DAYS_ALL,
  DAYS_WEEKDAYS,
  DAYS_WEEKENDS,
  daysLabel,
  describeReminder,
  formatMinuteOfDay,
  intervalLabel,
  parseMinuteOfDay,
} from "../src/lib/reminder-ui";

const base: Reminder = {
  id: "r1",
  babyId: null,
  kind: "feed",
  mode: "since_last",
  intervalMin: 180,
  atMinute: null,
  days: DAYS_ALL,
  tz: "Europe/Oslo",
  quietStart: null,
  quietEnd: null,
  label: null,
  lastFiredAt: null,
};

describe("describeReminder", () => {
  test("a plain feed gap", () => {
    expect(describeReminder(base)).toEqual({
      title: "Feed",
      detail: "after 3 h",
    });
  });

  test("a medicine gap names the medicine and the baby", () => {
    const r = {
      ...base,
      kind: "medicine" as const,
      label: "Paracetamol",
      intervalMin: 360,
      babyId: "b",
    };
    expect(describeReminder(r, "Nora")).toEqual({
      title: "Medicine",
      detail: "Paracetamol · after 6 h · Nora",
    });
  });

  test("a custom fixed time uses its label as the title", () => {
    const r = {
      ...base,
      kind: "custom" as const,
      mode: "at_time" as const,
      intervalMin: null,
      atMinute: 9 * 60,
      days: DAYS_WEEKDAYS,
      label: "Vitamin D",
      quietStart: 22,
      quietEnd: 7,
    };
    expect(describeReminder(r)).toEqual({
      title: "Vitamin D",
      detail: "at 09:00 · Weekdays · quiet 22:00–07:00",
    });
  });
});

describe("labels", () => {
  test("intervals", () => {
    expect(intervalLabel(120)).toBe("2 h");
    expect(intervalLabel(45)).toBe("45 min");
    expect(intervalLabel(90)).toBe("1 h 30 min");
  });
  test("day masks", () => {
    expect(daysLabel(DAYS_ALL)).toBe("Every day");
    expect(daysLabel(DAYS_WEEKDAYS)).toBe("Weekdays");
    expect(daysLabel(DAYS_WEEKENDS)).toBe("Weekends");
    expect(daysLabel(0b0000101)).toBe("Mon Wed");
  });
  test("minute of day round-trips", () => {
    expect(formatMinuteOfDay(545)).toBe("09:05");
    expect(parseMinuteOfDay("09:05")).toBe(545);
    expect(parseMinuteOfDay("23:59")).toBe(1439);
    expect(parseMinuteOfDay("24:00")).toBeNull();
    expect(parseMinuteOfDay("nine")).toBeNull();
  });
});
