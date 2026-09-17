import {
  IconBabyCarriage,
  IconBackpack,
  IconCalendarEvent,
  IconStethoscope,
  IconUsersGroup,
  IconVaccine,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import type { CalendarCategory, CalendarEvent } from "@pjokk/shared";

// Category tints reuse the existing per-category theme tokens (CLAUDE.md §7:
// tints on icons and badges only, never backgrounds) — no new colors.
export const calendarCategoryMeta: Record<
  CalendarCategory,
  { label: string; icon: TablerIcon; colorVar: string }
> = {
  doctor: {
    label: "Doctor",
    icon: IconStethoscope,
    colorVar: "var(--color-growth)",
  },
  vaccination: {
    label: "Vaccination",
    icon: IconVaccine,
    colorVar: "var(--color-diaper)",
  },
  babysitting: {
    label: "Babysitting",
    icon: IconBabyCarriage,
    colorVar: "var(--color-sleep)",
  },
  family: {
    label: "Family",
    icon: IconUsersGroup,
    colorVar: "var(--color-feed)",
  },
  // Barnehage (issue #110): planning days, parent meetings, photo day. The
  // accent, as the barnehage banner and its timeline row use.
  daycare: {
    label: "Daycare",
    icon: IconBackpack,
    colorVar: "var(--color-accent)",
  },
  other: {
    label: "Other",
    icon: IconCalendarEvent,
    colorVar: "var(--color-muted)",
  },
};

/** Local-date bucket key (YYYY-MM-DD) for grouping events by calendar day. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 42-cell month grid (6 weeks), Monday-start, containing `anchor`'s month. */
export function monthGridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(1 - mondayOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** Monday 00:00 of the week containing `anchor`. */
export function weekStart(anchor: Date): Date {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Closed days worth saying on Home (issue #110): a barnehage event flagged
// closed that falls on the local today or tomorrow. "Tomorrow" is the one
// that matters — it is what changes the evening's plans — so today's comes
// second only in the sense that it is already known; both are listed, today
// first, because that is the order they happen in.
export type ClosedNotice = {
  id: string;
  when: "today" | "tomorrow";
  title: string;
};

export function closedNotices(
  events: Pick<
    CalendarEvent,
    "id" | "category" | "closed" | "startTime" | "title"
  >[],
  now = new Date(),
): ClosedNotice[] {
  const today = dayKey(now);
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  const tomorrow = dayKey(next);
  const out: ClosedNotice[] = [];
  for (const e of events) {
    if (e.category !== "daycare" || !e.closed) continue;
    const key = dayKey(new Date(e.startTime));
    if (key === today)
      out.push({ id: `${e.id}:${key}`, when: "today", title: e.title });
    else if (key === tomorrow)
      out.push({ id: `${e.id}:${key}`, when: "tomorrow", title: e.title });
  }
  return out.sort((a, b) =>
    a.when === b.when ? 0 : a.when === "today" ? -1 : 1,
  );
}
