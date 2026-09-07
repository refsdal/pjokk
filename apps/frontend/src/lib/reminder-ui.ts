import type { Reminder, ReminderKind } from "@/lib/data/reminders";
import { t } from "@/lib/i18n";

// Words and numbers for reminders (issue #45), kept out of the sheet and
// the settings rows so both say the same thing and it is testable without
// React. Every label is an English source string passed through t() at the
// call site.

export const DAYS_ALL = 127; // bit 0 = Monday … bit 6 = Sunday
export const DAYS_WEEKDAYS = 31;
export const DAYS_WEEKENDS = 96;

export const kindLabel: Record<ReminderKind, string> = {
  feed: "Feed",
  diaper: "Diaper",
  pump: "Pump",
  medicine: "Medicine",
  custom: "Custom",
};

/** Gap presets for since_last, in minutes. */
export const intervalOptions = [120, 180, 240, 360, 480] as const;

export function intervalLabel(min: number): string {
  if (min % 60 === 0) return `${min / 60} h`;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function daysLabel(mask: number): string {
  if (mask === DAYS_ALL) return t("Every day");
  if (mask === DAYS_WEEKDAYS) return t("Weekdays");
  if (mask === DAYS_WEEKENDS) return t("Weekends");
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return names
    .filter((_, i) => mask & (1 << i))
    .map((n) => t(n))
    .join(" ");
}

/** "09:05" for 545. */
export function formatMinuteOfDay(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 545 for "09:05"; null for anything that is not HH:MM. */
export function parseMinuteOfDay(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export function quietLabel(start: number, end: number): string {
  const pad = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `${t("quiet")} ${pad(start)}–${pad(end)}`;
}

/** The IANA zone the phone is in, for the server to read wall-clock
 *  fields in. Falls back to UTC where Intl has nothing to say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The settings row: "Feed · after 3 h · Nora · quiet 22:00–07:00". */
export function describeReminder(
  r: Reminder,
  babyName?: string | null,
): { title: string; detail: string } {
  const title = r.kind === "custom" && r.label ? r.label : t(kindLabel[r.kind]);
  const parts: string[] = [];
  if (r.kind === "medicine" && r.label) parts.push(r.label);
  if (r.mode === "since_last" && r.intervalMin != null) {
    parts.push(`${t("after")} ${intervalLabel(r.intervalMin)}`);
  }
  if (r.mode === "at_time" && r.atMinute != null) {
    parts.push(`${t("at")} ${formatMinuteOfDay(r.atMinute)}`);
  }
  if (r.days !== DAYS_ALL) parts.push(daysLabel(r.days));
  if (babyName) parts.push(babyName);
  if (r.quietStart != null && r.quietEnd != null) {
    parts.push(quietLabel(r.quietStart, r.quietEnd));
  }
  return { title, detail: parts.join(" · ") };
}
