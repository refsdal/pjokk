import type { DaycareLog, DaycareMood, Handover } from "@pjokk/shared";
import type { FeedAppetite } from "@/lib/log-detail";

// The pick-up handover (issue #106): what the staff said, as one sheet over
// ordinary rows. This file is the sheet's pure half — the draft it edits,
// what the draft opens on, and the wire document it saves — so the rules
// can be tested without React.
//
// The sheet thinks in CLOCK TIMES on the day she was there ("11:30"), not
// in instants: that is how a handover is spoken, and it is what carries
// from one day to the next.

export type MealSlot = "breakfast" | "lunch" | "snack";

export const mealSlots: { key: MealSlot; label: string; clock: string }[] = [
  { key: "breakfast", label: "Breakfast", clock: "08:30" },
  { key: "lunch", label: "Lunch", clock: "11:00" },
  { key: "snack", label: "Snack", clock: "14:00" },
];

export const moodOptions: { value: DaycareMood; label: string }[] = [
  { value: "good", label: "Good day" },
  { value: "ok", label: "Okay" },
  { value: "hard", label: "Hard day" },
];

export const DEFAULT_NAP = { start: "11:30", end: "13:00" };
export const MAX_NAPS = 4;

export type NapDraft = { start: string; end: string };
export type MealDraft = {
  // Whether the sheet shows the slot at all: she was there at that hour,
  // or a meal was already saved in it.
  offered: boolean;
  clock: string;
  appetite: FeedAppetite | null;
  // Carried through untouched: the sheet has no food field, but a meal
  // edited in the feed sheet may have one, and PUT replaces every row.
  food: string | null;
};
export type HandoverDraft = {
  naps: NapDraft[];
  meals: Record<MealSlot, MealDraft>;
  // Meals the three slots could not hold (written over the API); saved
  // back as they came.
  otherMeals: Handover["meals"];
  wet: number;
  dirty: number;
  mood: DaycareMood | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const clockOf = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export type DaySpan = Pick<DaycareLog, "startTime" | "endTime">;

// A clock time on the local day she was dropped off.
export function onDay(day: Pick<DaycareLog, "startTime">, clock: string): Date {
  const d = new Date(day.startTime);
  d.setHours(0, minutesOf(clock), 0, 0);
  return d;
}

// The handover is about the hours she was THERE. The sheet speaks in whole
// minutes, so the day's edges are widened to the minute: a nap "from 08:10"
// on a day that began 08:10:37 is inside it. A day still running ends now.
// The server draws the same line (handover.go, OUTSIDE_DAY).
export function inDay(day: DaySpan, clock: string, now = new Date()): boolean {
  const start = new Date(day.startTime);
  start.setSeconds(0, 0);
  const end = day.endTime ? new Date(day.endTime) : now;
  const at = onDay(day, clock).getTime();
  return at >= start.getTime() && at <= end.getTime();
}

export const napOutsideDay = (n: NapDraft, day: DaySpan, now?: Date): boolean =>
  !inDay(day, n.start, now) || !inDay(day, n.end, now);

// What "Add a nap" adds: the usual nap when she was there for it, else the
// last hour and a half of the day (an early pick-up).
export function napToAdd(day: DaySpan, now = new Date()): NapDraft {
  if (!napOutsideDay(DEFAULT_NAP, day, now)) return DEFAULT_NAP;
  const end = day.endTime ? new Date(day.endTime) : now;
  end.setSeconds(0, 0);
  const dayStart = new Date(day.startTime);
  const start = new Date(
    Math.max(end.getTime() - 90 * 60_000, dayStart.getTime() + 60_000),
  );
  return {
    start: clockOf(start.toISOString()),
    end: clockOf(end.toISOString()),
  };
}

// Each saved meal goes to the slot whose usual time is nearest, first come
// first served; what is left over rides in otherMeals.
function slotMeals(meals: Handover["meals"]): {
  slotted: Partial<Record<MealSlot, Handover["meals"][number]>>;
  others: Handover["meals"];
} {
  const slotted: Partial<Record<MealSlot, Handover["meals"][number]>> = {};
  const others: Handover["meals"] = [];
  for (const meal of meals) {
    const at = minutesOf(clockOf(meal.time));
    const free = mealSlots
      .filter((s) => !slotted[s.key])
      .sort(
        (a, b) =>
          Math.abs(minutesOf(a.clock) - at) - Math.abs(minutesOf(b.clock) - at),
      )[0];
    if (free) slotted[free.key] = meal;
    else others.push(meal);
  }
  return { slotted, others };
}

// What the sheet opens on. `saved` is this day's own handover (an edit):
// everything comes from it. Otherwise it is a new one, and only the CLOCK
// TIMES carry over from `previous` (last-value prefill, CLAUDE.md §3) — how
// she ate, how many nappies and how the day went are observations of this
// day and never prefill.
//
// Whatever is prefilled must fit the hours she was there: picked up at noon
// with a fever, she did not nap 11:30–13:00, and a row saved for 13:00
// would sit in the future. A usual nap that does not fit is not offered,
// and neither is a meal slot outside the day.
export function draftFor(
  saved: Handover | null | undefined,
  previous: Handover | null | undefined,
  day: DaySpan,
  now = new Date(),
): HandoverDraft {
  const isEdit =
    !!saved &&
    (saved.naps.length > 0 ||
      saved.meals.length > 0 ||
      saved.diapers.wet + saved.diapers.dirty > 0 ||
      saved.mood !== null);
  const source = isEdit ? saved : previous;
  const { slotted, others } = slotMeals(source?.meals ?? []);
  const meals = Object.fromEntries(
    mealSlots.map((s) => {
      const m = slotted[s.key];
      const clock = m ? clockOf(m.time) : s.clock;
      return [
        s.key,
        {
          offered: (isEdit && !!m) || inDay(day, clock, now),
          clock,
          appetite: isEdit ? (m?.appetite ?? null) : null,
          food: isEdit ? (m?.food ?? null) : null,
        },
      ];
    }),
  ) as Record<MealSlot, MealDraft>;
  const naps = (source?.naps ?? []).map((n) => ({
    start: clockOf(n.startTime),
    end: clockOf(n.endTime),
  }));
  return {
    // An edit shows exactly the naps it has, none included ("No nap"); a
    // new handover opens on one, since most days have one.
    naps: isEdit
      ? naps
      : [naps[0] ?? DEFAULT_NAP].filter((n) => !napOutsideDay(n, day, now)),
    meals,
    otherMeals: isEdit ? others : [],
    wet: isEdit ? saved.diapers.wet : 0,
    dirty: isEdit ? saved.diapers.dirty : 0,
    mood: isEdit ? saved.mood : null,
  };
}

export const napIsBackwards = (n: NapDraft): boolean =>
  minutesOf(n.end) <= minutesOf(n.start);

// The wire document. A meal is only a meal once someone said how it went;
// a slot left untouched writes nothing.
export function toHandover(
  draft: HandoverDraft,
  day: Pick<DaycareLog, "startTime">,
): Handover {
  return {
    naps: draft.naps
      .filter((n) => !napIsBackwards(n))
      .map((n) => ({
        startTime: onDay(day, n.start).toISOString(),
        endTime: onDay(day, n.end).toISOString(),
      })),
    meals: [
      ...mealSlots
        .filter((s) => draft.meals[s.key].appetite !== null)
        .map((s) => ({
          time: onDay(day, draft.meals[s.key].clock).toISOString(),
          appetite: draft.meals[s.key].appetite,
          food: draft.meals[s.key].food,
        })),
      ...draft.otherMeals,
    ],
    diapers: { wet: draft.wet, dirty: draft.dirty },
    mood: draft.mood,
  };
}

// Home's "How was the day?" card can be waved away on this device without
// writing anything: the id of the day it was dismissed for.
const DISMISSED_KEY = "pjokk.handover.dismissed";
export function handoverDismissed(dayId: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === dayId;
  } catch {
    return false;
  }
}
export function dismissHandover(dayId: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, dayId);
  } catch {
    // A private window: the card comes back, which is the honest failure.
  }
}
