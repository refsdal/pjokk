import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { t } from "./i18n";

// The medicine catalogue's own arithmetic (issue #49). Nothing here is
// medical: the interval is the family's number, and the app only adds it
// to the last dose and says when that lands.

/** Interval presets for the catalogue sheet, in minutes. */
export const medicineIntervalOptions = [240, 360, 480, 720, 1440] as const;

export function medicineIntervalLabel(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} d`;
  if (min % 60 === 0) return `${min / 60} h`;
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * When the next dose is allowed by the family's own interval, or null when
 * there is no interval, no dose yet, or the interval has already passed.
 * A supplement never gets a caution: vitamin D at 09:00 and again at 09:30
 * is a mistake nobody needs a warning about.
 */
export function nextDoseFrom(
  entry: Pick<
    MedicineCatalogueEntry,
    "minIntervalMin" | "lastDoseAt" | "isSupplement"
  >,
  now: Date | number = Date.now(),
): Date | null {
  if (entry.isSupplement || !entry.minIntervalMin || !entry.lastDoseAt)
    return null;
  const at =
    new Date(entry.lastDoseAt).getTime() + entry.minIntervalMin * 60_000;
  return at > +now ? new Date(at) : null;
}

/** "2.5 ml · every 6 h · supplement" — the row detail in Settings. */
export function medicineDetail(entry: MedicineCatalogueEntry): string {
  return [
    entry.defaultAmount != null
      ? `${entry.defaultAmount} ${entry.unit ?? ""}`.trim()
      : null,
    entry.minIntervalMin
      ? `${t("every")} ${medicineIntervalLabel(entry.minIntervalMin)}`
      : null,
    entry.isSupplement ? t("supplement") : null,
    entry.archived ? t("archived") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
