import { IconVirus } from "@tabler/icons-react";
import type { IllnessLog, IllnessSymptom } from "@pjokk/shared";
import { t } from "@/lib/i18n";
import { isFever } from "@/lib/measurements";
import { describeTime } from "@/lib/time";

// An illness episode (issue #107). This file is the episode's pure half:
// the words, and the one piece of arithmetic the feature exists for — how
// long she has been symptom-free, against the FAMILY's own number of hours.
//
// The app ships no medical judgement (the medicine interval's stance, issue
// #49). Nothing here says a child "may return": it says when the last
// symptom was and when the family's chosen number of hours will have
// passed since. FHI's guidance is quoted beside the choice, as reference.

export const illnessMeta = {
  label: "Illness",
  icon: IconVirus,
  // Growth's coral, where temperatures already live. Not the danger token:
  // an illness card sits on Home for days and is not an alarm.
  tint: "text-growth",
} as const;

export const symptomLabel: Record<IllnessSymptom, string> = {
  fever: "Fever",
  vomiting: "Vomiting",
  diarrhoea: "Diarrhoea",
  cough: "Cough",
  cold: "Cold",
  rash: "Rash",
  eye: "Eye infection",
  ear: "Earache",
  other: "Other",
};

// Folkehelseinstituttet, «Når må barnet være hjemme fra barnehagen?»: two
// full days symptom-free after vomiting or diarrhoea; everything else goes
// by general condition. Quoted in the sheet; the number below is only what
// the chips open on, and the family can change it or take it away.
export const FHI_URL =
  "https://www.fhi.no/sm/barnehage/nar-ma-barnet-vare-hjemme-fra-barne/";
export const clearHourChoices = [24, 48, 72] as const;

export function suggestedClearHours(symptoms: IllnessSymptom[]): number | null {
  return symptoms.includes("vomiting") || symptoms.includes("diarrhoea")
    ? 48
    : null;
}

type Reading = { type: string; value: number; time: string };

// When the last symptom was, all things known. `lastSymptomAt` is what the
// family said; a fever reading logged AFTER it is a symptom they have not
// told the card about, so it moves the moment forward. Null means she still
// has symptoms (nobody has said otherwise).
export function lastSymptom(
  illness: Pick<IllnessLog, "lastSymptomAt">,
  readings: Reading[] = [],
): Date | null {
  if (!illness.lastSymptomAt) return null;
  let last = new Date(illness.lastSymptomAt).getTime();
  for (const r of readings) {
    const at = new Date(r.time).getTime();
    if (at > last && isFever(r.type as "temperature", r.value)) last = at;
  }
  return new Date(last);
}

export type IllnessClock =
  | { state: "symptoms" }
  | { state: "free"; since: Date }
  | { state: "counting"; since: Date; hours: number; at: Date }
  | { state: "passed"; since: Date; hours: number; at: Date };

export function illnessClock(
  illness: Pick<IllnessLog, "lastSymptomAt" | "clearHours">,
  readings: Reading[] = [],
  now = new Date(),
): IllnessClock {
  const since = lastSymptom(illness, readings);
  if (!since) return { state: "symptoms" };
  if (!illness.clearHours) return { state: "free", since };
  const hours = illness.clearHours;
  const at = new Date(since.getTime() + hours * 3_600_000);
  return now.getTime() >= at.getTime()
    ? { state: "passed", since, hours, at }
    : { state: "counting", since, hours, at };
}

/** The card's clock, one fact per line so neither is ever cut short: the
 *  moment the hours are reached is the one thing a parent opens the app to
 *  read, and it sat at the truncated end of a single line. Never a verdict:
 *  a moment, and the family's number of hours measured from it. */
export function clockLines(clock: IllnessClock, now = new Date()): string[] {
  switch (clock.state) {
    case "symptoms":
      return [t("Still has symptoms")];
    case "free":
      return [`${t("Symptom-free since")} ${describeTime(clock.since, now)}`];
    case "counting":
      return [
        `${t("Symptom-free since")} ${describeTime(clock.since, now)}`,
        `${clock.hours} ${t("h on")} ${describeTime(clock.at, now)}`,
      ];
    case "passed":
      return [
        `${clock.hours} ${t("h symptom-free since")} ${describeTime(clock.at, now)}`,
      ];
  }
}

export const symptomsLine = (symptoms: IllnessSymptom[]): string =>
  symptoms.map((s) => t(symptomLabel[s]).toLowerCase()).join(" · ");

/** Whole days an episode has lasted, for the timeline row; at least 1. */
export function illnessDays(
  e: Pick<IllnessLog, "startTime" | "endTime">,
  now = new Date(),
): number {
  const end = e.endTime ? new Date(e.endTime) : now;
  const ms = end.getTime() - new Date(e.startTime).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}
