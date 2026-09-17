import { describe, expect, it } from "bun:test";
import type { DaycarePlace, PickupPlan } from "@pjokk/shared";
import {
  clockMinute,
  closingState,
  daycareBannerLine,
  directionsUrl,
  minuteClock,
  pickupToday,
  planGrid,
} from "../src/lib/daycare-ui";

// The barnehage as a place and the pick-up plan (spec
// 2026-09-17-daycare-place-and-pickup-plan-design.md): the client resolves
// "today", because it is the one with a calendar.

const place = (over: Partial<DaycarePlace> = {}): DaycarePlace => ({
  id: "p1",
  name: "Solsikken",
  address: "Storgata 1, 0155 Oslo",
  phone: null,
  email: null,
  website: null,
  notes: null,
  openMinute: 450,
  closeMinute: 990, // 16:30
  alertLeadMin: 30,
  tz: "Europe/Oslo",
  babyIds: ["b1"],
  ...over,
});

const plan: PickupPlan = {
  days: [
    { weekday: 1, minute: 930, userId: "anne" },
    { weekday: 2, minute: 930, userId: "bo" },
    { weekday: 5, minute: 840, userId: null },
  ],
  overrides: [{ date: "2026-03-17", userId: "anne" }],
};

// Local-time constructors: the resolver reads the device's own calendar.
const monday = (h: number, m = 0) => new Date(2026, 2, 16, h, m);
const tuesday = (h: number, m = 0) => new Date(2026, 2, 17, h, m);

describe("minuteClock", () => {
  it("reads minutes after midnight as a 24-hour clock", () => {
    expect(minuteClock(990)).toBe("16:30");
    expect(minuteClock(450)).toBe("07:30");
    expect(minuteClock(0)).toBe("00:00");
  });
});

describe("pickupToday", () => {
  it("reads the weekday off the grid", () => {
    expect(pickupToday(plan, monday(9))).toEqual({
      minute: 930,
      userId: "anne",
      plannedUserId: "anne",
      overridden: false,
    });
  });

  it("lets a one-day exception name someone else and keeps the time", () => {
    expect(pickupToday(plan, tuesday(9))).toEqual({
      minute: 930,
      userId: "anne",
      plannedUserId: "bo",
      overridden: true,
    });
  });

  it("knows a day with a time and nobody named", () => {
    expect(pickupToday(plan, new Date(2026, 2, 20, 9))?.userId).toBeNull();
  });

  it("says nothing for a day nobody planned, a weekend or no plan", () => {
    expect(pickupToday(plan, new Date(2026, 2, 18, 9))).toBeNull(); // Wednesday
    expect(pickupToday(plan, new Date(2026, 2, 21, 9))).toBeNull(); // Saturday
    expect(pickupToday(null, monday(9))).toBeNull();
  });

  it("honours an exception on a day the grid leaves out", () => {
    const p: PickupPlan = {
      days: [],
      overrides: [{ date: "2026-03-18", userId: "bo" }],
    };
    expect(pickupToday(p, new Date(2026, 2, 18, 9))).toEqual({
      minute: null,
      userId: "bo",
      plannedUserId: null,
      overridden: true,
    });
  });
});

describe("closingState", () => {
  it("is later, then soon inside the family's lead, then closed", () => {
    expect(closingState(place(), monday(12))).toEqual({
      kind: "later",
      closeMinute: 990,
      minutesLeft: 270,
    });
    expect(closingState(place(), monday(16, 5))?.kind).toBe("soon");
    expect(closingState(place(), monday(16, 5))?.minutesLeft).toBe(25);
    expect(closingState(place(), monday(16, 30))?.kind).toBe("closed");
  });

  it("uses half an hour when the family switched the push off", () => {
    expect(
      closingState(place({ alertLeadMin: null }), monday(16, 1))?.kind,
    ).toBe("soon");
    expect(
      closingState(place({ alertLeadMin: null }), monday(15, 59))?.kind,
    ).toBe("later");
  });

  it("is nothing without a closing time or a place", () => {
    expect(closingState(place({ closeMinute: null }), monday(12))).toBeNull();
    expect(closingState(null, monday(12))).toBeNull();
  });
});

describe("daycareBannerLine", () => {
  const names = (id: string) => ({ anne: "Anne", bo: "Bo" })[id] ?? null;
  const today = { place: place(), plan };

  it("says the plan for most of the day", () => {
    expect(daycareBannerLine(today, names, monday(12))).toBe(
      "Pick-up 15:30 · Anne",
    );
  });

  it("says the closing time once it is near, and once it has passed", () => {
    expect(daycareBannerLine(today, names, monday(16, 5))).toBe(
      "Closes 16:30 · in 25 min",
    );
    expect(daycareBannerLine(today, names, monday(16, 45))).toBe(
      "Closed at 16:30",
    );
  });

  it("makes do with half a plan", () => {
    const friday = new Date(2026, 2, 20, 12);
    expect(daycareBannerLine(today, names, friday)).toBe("Pick-up 14:00");
    const onlyWho = {
      place: null,
      plan: {
        days: [{ weekday: 1, minute: null, userId: "bo" }],
        overrides: [],
      },
    };
    expect(daycareBannerLine(onlyWho, names, monday(12))).toBe("Pick-up · Bo");
  });

  it("falls back to the closing time on an unplanned day", () => {
    const wednesday = new Date(2026, 2, 18, 12);
    expect(daycareBannerLine(today, names, wednesday)).toBe("Closes 16:30");
  });

  it("says nothing with nothing to say", () => {
    expect(daycareBannerLine(null, names, monday(12))).toBeNull();
    expect(
      daycareBannerLine(
        {
          place: place({ closeMinute: null }),
          plan: { days: [], overrides: [] },
        },
        names,
        monday(12),
      ),
    ).toBeNull();
  });
});

describe("directionsUrl", () => {
  it("searches for the address, with the name to disambiguate", () => {
    expect(directionsUrl(place())).toBe(
      "https://www.google.com/maps/search/?api=1&query=Solsikken%2C%20Storgata%201%2C%200155%20Oslo",
    );
    expect(directionsUrl(place({ address: null }))).toBeNull();
  });
});

describe("planGrid", () => {
  it("is always Monday to Friday, planned or not", () => {
    const grid = planGrid(plan);
    expect(grid.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(grid[2]).toEqual({ weekday: 3, minute: null, userId: null });
    expect(grid[4]).toEqual({ weekday: 5, minute: 840, userId: null });
    expect(planGrid(null)).toHaveLength(5);
  });
});

describe("clockMinute", () => {
  it("reads a time input, and a blank one as not set", () => {
    expect(clockMinute("16:30")).toBe(990);
    expect(clockMinute("")).toBeNull();
  });
});
