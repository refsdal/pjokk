import { t } from "./i18n";

// Norwegian conventions for clocks/dates (24h, nb-NO); the relative and age
// words go through t() like all other user-facing copy.

const timeFmt = new Intl.DateTimeFormat("nb-NO", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dayFmt = new Intl.DateTimeFormat("nb-NO", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

export function formatClock(d: Date): string {
  return timeFmt.format(d);
}

export function formatDay(d: Date): string {
  return dayFmt.format(d);
}

/** "just now", "5 m ago", "2 h ago", "yesterday 21:14", "man. 12. jan 08:30" */
export function formatRelative(date: Date, now = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return t("just now");
  if (min < 60) return `${min} ${t("m ago")}`;
  const hours = Math.floor(min / 60);
  // Relative for anything within 24h regardless of the calendar day —
  // "yesterday 22:30" at 00:30 is exactly wrong at 3am.
  if (hours < 24) return `${hours} ${t("h ago")}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `${t("yesterday")} ${formatClock(date)}`;
  return `${formatDay(date)} ${formatClock(date)}`;
}

/** YYYY-MM-DD in LOCAL time, for <input type="date"> value/max (an ISO
 * slice would shift the day near midnight in non-UTC timezones). */
export function toLocalDateInput(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "1:42" (h:mm) or "42 min" for running sleep counters. */
export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} ${t("min")}`;
  const h = Math.floor(min / 60);
  return `${h}:${String(min % 60).padStart(2, "0")}`;
}

/** Baby age: "12 d", "10 mo", "1 y 2 mo" */
export function formatAge(birthDate: Date, now = new Date()): string {
  const days = Math.floor(
    (now.getTime() - birthDate.getTime()) / (24 * 3600_000),
  );
  if (days < 60) return `${days} ${t("d")}`;
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 +
    (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  if (months < 24) return `${months} ${t("mo")}`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0
    ? `${years} ${t("y")}`
    : `${years} ${t("y")} ${rem} ${t("mo")}`;
}
