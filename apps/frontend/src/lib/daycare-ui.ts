import { IconBackpack } from "@tabler/icons-react";
import type { DaycareLog } from "@pjokk/shared";

// A day at barnehage (issue #105). The code says "daycare"; the UI says the
// family's word through t(): "Barnehage" in Norwegian, "Daycare" in
// English. The accent tint rather than a category colour — it is none of
// sleep, feeds, diapers or growth — and on the icon only (CLAUDE.md §7).
export const daycareMeta = {
  label: "Daycare",
  icon: IconBackpack,
  tint: "text-accent",
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
