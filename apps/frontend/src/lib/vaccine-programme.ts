import type { VaccineLog } from "@pjokk/shared";
import programme from "@/data/no-vaccine-programme.json";

// The bundled Norwegian programme is a REFERENCE OVERLAY, never a
// constraint: it says what the helsestasjon normally offers and when, and
// nothing here ever blocks logging a vaccine that isn't in it (given
// abroad, off-programme, or a schedule that has since changed).
//
// We make no claims about any vaccine. The only thing we say about one is
// where FHI's own page for it lives.

export type ProgrammeSlot = {
  key: string;
  /** Key into `vaccines` — several doses share one vaccine. */
  vaccine: string;
  name: string;
  dose: number;
  ageMonths: number;
  ageLabel: string;
};

export type ProgrammeVaccine = { label: string; infoUrl: string };

export const vaccineProgramme = programme as {
  name: string;
  source: string;
  sourceUrl: string;
  sourceRevisedAt: string;
  vaccines: Record<string, ProgrammeVaccine>;
  slots: ProgrammeSlot[];
};

export type SlotStatus = "given" | "due" | "upcoming" | "dismissed";

export type ScheduleRow = {
  slot: ProgrammeSlot;
  status: SlotStatus;
  /** The entry that filled this slot, when there is one. */
  entry: VaccineLog | null;
  /** When the programme nominally offers it, derived from the birth date. */
  dueAt: Date;
};

const MONTH_MS = 30.436875 * 24 * 3600_000;

/** A dose fills a slot either explicitly, or by matching name + dose number
 *  — so a record imported or typed by hand still lands in the right row. */
function entryForSlot(
  slot: ProgrammeSlot,
  entries: VaccineLog[],
): VaccineLog | null {
  const explicit = entries.find((e) => e.scheduleSlot === slot.key);
  if (explicit) return explicit;
  return (
    entries.find(
      (e) =>
        e.scheduleSlot === null &&
        e.name.trim().toLowerCase() === slot.name.toLowerCase() &&
        e.doseNumber === slot.dose,
    ) ?? null
  );
}

export function buildSchedule(
  birthDate: Date,
  entries: VaccineLog[],
  dismissedKeys: readonly string[] = [],
  now = new Date(),
): ScheduleRow[] {
  const dismissed = new Set(dismissedKeys);
  return vaccineProgramme.slots.map((slot) => {
    const dueAt = new Date(birthDate.getTime() + slot.ageMonths * MONTH_MS);
    const entry = entryForSlot(slot, entries);
    // A logged dose always beats a dismissal: dismissing a slot never blocks
    // recording it later, and no row is ever in two lists at once.
    const status: SlotStatus = entry
      ? "given"
      : dismissed.has(slot.key)
        ? "dismissed"
        : dueAt.getTime() <= now.getTime()
          ? "due"
          : "upcoming";
    return { slot, status, entry, dueAt };
  });
}

/** Entries that don't correspond to any programme slot — shown separately so
 *  nothing a family logged can quietly vanish from the screen. */
export function offProgramme(
  entries: VaccineLog[],
  schedule: ScheduleRow[],
): VaccineLog[] {
  const claimed = new Set(
    schedule.map((r) => r.entry?.id).filter((id): id is string => !!id),
  );
  return entries.filter((e) => !claimed.has(e.id));
}

/** FHI's page for the vaccine behind a slot key ("mmr:1" → the MMR page), or
 *  null for anything off-programme — we link to the government's page or to
 *  nothing at all, never to a guess. */
export function infoUrlForSlot(slotKey: string | null): string | null {
  if (!slotKey) return null;
  const vaccineKey = slotKey.split(":")[0] ?? "";
  return vaccineProgramme.vaccines[vaccineKey]?.infoUrl ?? null;
}

/** Same, for an entry with no slot key: matches the programme by vaccine
 *  name so a hand-typed "MMR" still gets FHI's page. */
export function infoUrlForName(name: string): string | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const hit = Object.values(vaccineProgramme.vaccines).find(
    (v) => v.label.toLowerCase() === needle,
  );
  return hit?.infoUrl ?? null;
}
