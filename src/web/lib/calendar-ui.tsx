import {
  IconBabyCarriage,
  IconCalendarEvent,
  IconStethoscope,
  IconUsersGroup,
  IconVaccine,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import type { CalendarCategory } from "@shared/schemas";

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
