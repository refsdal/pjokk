import type { VaccineLog } from "@shared/schemas";
import programme from "@/data/no-vaccine-programme.json";

// The bundled Norwegian programme is a REFERENCE OVERLAY, never a
// constraint: it says what the helsestasjon normally offers and when, and
// nothing here ever blocks logging a vaccine that isn't in it (given
// abroad, off-programme, or a schedule that has since changed).

export type ProgrammeSlot = {
  key: string;
  name: string;
  dose: number;
  ageMonths: number;
  ageLabel: string;
};

export const vaccineProgramme = programme as {
  name: string;
  source: string;
  sourceUrl: string;
  slots: ProgrammeSlot[];
};

export type SlotStatus = "given" | "due" | "upcoming";

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
  now = new Date(),
): ScheduleRow[] {
  return vaccineProgramme.slots.map((slot) => {
    const dueAt = new Date(birthDate.getTime() + slot.ageMonths * MONTH_MS);
    const entry = entryForSlot(slot, entries);
    const status: SlotStatus = entry
      ? "given"
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
