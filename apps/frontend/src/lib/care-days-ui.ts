import type { CareDay, CareDayTotal } from "@pjokk/shared";
import { t } from "@/lib/i18n";

// Days at home with an ill child (issue #108): the pure half — the tap
// cycle on a face, the running count, and the fourth-day note.
//
// NAV's rule is reference text, never arithmetic: the quota is a number
// each person sets, and with none set the line is just what they have used.
export const NAV_URL = "https://www.nav.no/omsorgspenger";

export type Fraction = 0.5 | 1;

// One face, three states. A tap on a chip walks none → whole → half → none:
// a whole day is the common case and costs one tap.
export function nextFraction(
  current: Fraction | undefined,
): Fraction | undefined {
  if (current === undefined) return 1;
  return current === 1 ? 0.5 : undefined;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "4.5 of 10 days", or "4.5 days" for someone who has set no number. */
export function totalLine(total: Pick<CareDayTotal, "used" | "quota">): string {
  const unit = total.used === 1 && total.quota === null ? t("day") : t("days");
  return total.quota === null
    ? `${fmt(total.used)} ${unit}`
    : `${fmt(total.used)} ${t("of")} ${total.quota} ${t("days")}`;
}

const dayNumber = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
};

/** How many calendar days in a row, ending on `upTo`, this person has been
 *  home. Half days count as days: the run is about the calendar. */
export function consecutiveDays(
  days: Pick<CareDay, "userId" | "date">[],
  userId: string,
  upTo: string,
): number {
  const mine = new Set(
    days.filter((d) => d.userId === userId).map((d) => dayNumber(d.date)),
  );
  let run = 0;
  for (let n = dayNumber(upTo); mine.has(n); n--) run++;
  return run;
}

// From the fourth calendar day in a row an employer may ask for a doctor's
// note (the first three are self-certified). A note, never a block.
export const DOCTORS_NOTE_FROM_DAY = 4;
