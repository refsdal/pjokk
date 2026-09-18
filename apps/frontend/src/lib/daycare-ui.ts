import { IconBackpack } from "@tabler/icons-react";
import type {
  DaycareLog,
  DaycarePlace,
  DaycareToday,
  PickupPlan,
  PickupPlanDay,
} from "@pjokk/shared";
import { t } from "./i18n";
import { toLocalDateInput } from "./time";

// A day at barnehage (issue #105). The code says "daycare"; the UI says the
// family's word through t(): "Barnehage" in Norwegian, "Daycare" in
// English. Its own category colour since 2026-09-18 (--color-daycare, a
// dark green): the header ring takes it while she is there, so the tile,
// banner, calendar category and Stats marks must agree with the ring.
export const daycareMeta = {
  label: "Daycare",
  icon: IconBackpack,
  tint: "text-daycare",
} as const;

// The line a Last feed / Last diaper card gains while she is there: only
// when the card's entry predates the drop-off, which is when "7 hours ago"
// would otherwise read as news. A feed logged since (a handover, a parent
// at tilvenning) makes the card current again and the line goes.
export function predatesDropOff(
  last: string | null | undefined,
  active: Pick<DaycareLog, "startTime"> | null | undefined,
): boolean {
  if (!last || !active) return false;
  return new Date(last).getTime() < new Date(active.startTime).getTime();
}

// Last-value prefill (CLAUDE.md §3) for a finished day logged after the
// fact: the drop-off was probably when it was last time, so the field opens
// on today at the previous day's clock time. Null — leave it on "Now" —
// with no previous day, or when that clock time has not come yet today.
export function usualDropOff(
  lastStart: string | null | undefined,
  now = new Date(),
): Date | null {
  if (!lastStart) return null;
  const last = new Date(lastStart);
  const today = new Date(now);
  today.setHours(last.getHours(), last.getMinutes(), 0, 0);
  return today.getTime() < now.getTime() ? today : null;
}

// ---------------------------------------------------------------------
// The barnehage as a place, and who collects her (spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
// The server hands over the grid and the one-day exceptions and resolves
// no "today": the device has the calendar, so the resolving is here, pure.
// Opening hours are wall-clock minutes compared with the device's own
// clock, as the usual-nap minute is.
// ---------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes after local midnight as "16:30". */
export function minuteClock(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

export type PickupToday = {
  minute: number | null;
  // Who collects today: the exception's person, else the grid's.
  userId: string | null;
  // The grid's person, whoever collects — tapping them clears an exception.
  plannedUserId: string | null;
  overridden: boolean;
};

// Today's pick-up off the plan, or null when the day holds nothing.
export function pickupToday(
  plan: PickupPlan | null | undefined,
  now = new Date(),
): PickupToday | null {
  if (!plan) return null;
  const day = plan.days.find((d) => d.weekday === isoWeekday(now));
  const override = plan.overrides.find((o) => o.date === toLocalDateInput(now));
  if (!day && !override) return null;
  return {
    minute: day?.minute ?? null,
    userId: override?.userId ?? day?.userId ?? null,
    plannedUserId: day?.userId ?? null,
    overridden: !!override,
  };
}

// The banner turns to the closing time this long before it when the family
// has switched the push off; otherwise it follows the push's own lead.
const DEFAULT_CLOSING_LEAD_MIN = 30;

export type ClosingState = {
  kind: "later" | "soon" | "closed";
  closeMinute: number;
  minutesLeft: number;
};

export function closingState(
  place: Pick<DaycarePlace, "closeMinute" | "alertLeadMin"> | null | undefined,
  now = new Date(),
): ClosingState | null {
  if (!place || place.closeMinute == null) return null;
  const minutesLeft =
    place.closeMinute - (now.getHours() * 60 + now.getMinutes());
  const lead = place.alertLeadMin ?? DEFAULT_CLOSING_LEAD_MIN;
  return {
    kind: minutesLeft <= 0 ? "closed" : minutesLeft <= lead ? "soon" : "later",
    closeMinute: place.closeMinute,
    minutesLeft,
  };
}

// The At-daycare banner's second line. The plan for most of the day; the
// closing time once it is near — the one thing here with a deadline.
export function daycareBannerLine(
  today: DaycareToday | null | undefined,
  nameOf: (userId: string) => string | null,
  now = new Date(),
): string | null {
  if (!today) return null;
  const closing = closingState(today.place, now);
  if (closing?.kind === "closed")
    return `${t("Closed at")} ${minuteClock(closing.closeMinute)}`;
  if (closing?.kind === "soon")
    return `${t("Closes")} ${minuteClock(closing.closeMinute)} · ${t("in")} ${closing.minutesLeft} ${t("min")}`;

  const pickup = pickupToday(today.plan, now);
  const who = pickup?.userId ? nameOf(pickup.userId) : null;
  if (pickup && (pickup.minute !== null || who)) {
    const clock =
      pickup.minute !== null ? ` ${minuteClock(pickup.minute)}` : "";
    return `${t("Pick-up")}${clock}${who ? ` · ${who}` : ""}`;
  }
  return closing ? `${t("Closes")} ${minuteClock(closing.closeMinute)}` : null;
}

/** A maps search for the place; null without an address. */
export function directionsUrl(
  place: Pick<DaycarePlace, "name" | "address">,
): string | null {
  if (!place.address) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name}, ${place.address}`)}`;
}

// The settings grid: always Monday to Friday, planned or not.
export const PLAN_WEEKDAYS = [1, 2, 3, 4, 5] as const;
// Literal t() calls, so the i18n coverage check sees every one.
export function weekdayLabel(weekday: number): string {
  switch (weekday) {
    case 1:
      return t("Monday");
    case 2:
      return t("Tuesday");
    case 3:
      return t("Wednesday");
    case 4:
      return t("Thursday");
    default:
      return t("Friday");
  }
}

export function planGrid(
  plan: Pick<PickupPlan, "days"> | null | undefined,
): PickupPlanDay[] {
  return PLAN_WEEKDAYS.map(
    (weekday) =>
      plan?.days.find((d) => d.weekday === weekday) ?? {
        weekday,
        minute: null,
        userId: null,
      },
  );
}

/** "16:30" from a time input as minutes after midnight; null when blank. */
export function clockMinute(value: string): number | null {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
}
