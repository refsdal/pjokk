import {
  IconBabyBottle,
  IconBath,
  IconDiaper,
  IconMilk,
  IconMoon,
  IconNote,
  IconPill,
  IconRuler,
  IconSparkles,
  IconStretching,
  IconVaccine,
  type TablerIcon,
} from "@tabler/icons-react";
import { useMemo } from "react";
import type { Baby, Feature } from "@pjokk/shared";
import { features } from "@pjokk/shared";
import type { OtherKind } from "@/lib/data/other";
import type { ReminderKind } from "@/lib/data/reminders";
import { daycareMeta } from "@/lib/daycare-ui";
import { illnessMeta } from "@/lib/illness-ui";
import { playKindMeta } from "@/lib/play-ui";

// What the family tracks for one baby (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md). The set
// lives on Baby.features, chosen on the carousel (components/tracking/);
// this file is the catalogue behind the cards, the age-band
// recommendation, and the ONE way a screen asks "is this on?" — nothing
// reads the array directly.

export type FeatureGroup = "everyday" | "health" | "daycare" | "extras";

export type FeatureMeta = {
  key: Feature;
  // English; rendered through t().
  label: string;
  description: string;
  group: FeatureGroup;
  tint: string;
  icon: TablerIcon;
};

export const groupTitles: Record<FeatureGroup, string> = {
  everyday: "Everyday",
  health: "Health",
  daycare: "Barnehage",
  extras: "Extras",
};

export const featureCatalogue: FeatureMeta[] = [
  {
    key: "feeds",
    label: "Feeds",
    description:
      "Bottles, nursing with a timer, and solids. The last feed at a glance, intake per day, and a nudge when it has been a while.",
    group: "everyday",
    tint: "text-feed",
    icon: IconBabyBottle,
  },
  {
    key: "pump",
    label: "Pumping",
    description:
      "A pump timer every caretaker can see, and the amounts over the day.",
    group: "everyday",
    tint: "text-feed",
    icon: IconMilk,
  },
  {
    key: "sleep",
    label: "Sleep",
    description:
      "One tap when she falls asleep, one when she wakes. How long she has been up, naps today, and last night's longest stretch.",
    group: "everyday",
    tint: "text-sleep",
    icon: IconMoon,
  },
  {
    key: "diapers",
    label: "Diapers",
    description: "Wet, dirty or both in two taps, and the count for today.",
    group: "everyday",
    tint: "text-diaper",
    icon: IconDiaper,
  },
  {
    key: "medicine",
    label: "Medicine",
    description:
      "Doses from the family's own list, and when the next one is OK from.",
    group: "health",
    tint: "text-growth",
    icon: IconPill,
  },
  {
    key: "measurements",
    label: "Growth and temperature",
    description:
      "Weight, length and head against the WHO curves, and a temperature with a fever flag.",
    group: "health",
    tint: "text-growth",
    icon: IconRuler,
  },
  {
    key: "milestones",
    label: "Milestones",
    description: "First smile, first steps — with up to three photos each.",
    group: "extras",
    tint: "text-accent",
    icon: IconSparkles,
  },
  {
    key: "bath",
    label: "Baths",
    description: "When she last had one.",
    group: "extras",
    tint: "text-diaper",
    icon: IconBath,
  },
  {
    key: "notes",
    label: "Notes",
    description: "A line about anything, on the timeline where it happened.",
    group: "extras",
    tint: "text-muted",
    icon: IconNote,
  },
  {
    key: "play",
    label: "Play",
    description: "Tummy time, walks and play, timed from Home.",
    group: "extras",
    tint: playKindMeta.tummy.tint,
    icon: IconStretching,
  },
  {
    key: "daycare",
    label: "Barnehage",
    description:
      "Drop-off to pick-up, what the staff said, the pick-up plan and a heads-up before closing time.",
    group: "daycare",
    tint: daycareMeta.tint,
    icon: daycareMeta.icon,
  },
  {
    key: "illness",
    label: "Illness",
    description:
      "An episode from first symptom to recovered, and the days at home with a sick child.",
    group: "health",
    tint: illnessMeta.tint,
    icon: illnessMeta.icon,
  },
  {
    key: "vaccines",
    label: "Vaccines",
    description:
      "The Norwegian programme as a checklist, with a place for the documents.",
    group: "health",
    tint: "text-growth",
    icon: IconVaccine,
  },
];

// The carousel's order: group order, then the catalogue's within a group.
const groupOrder: FeatureGroup[] = ["everyday", "health", "daycare", "extras"];
export const featureCards: FeatureMeta[] = groupOrder.flatMap((g) =>
  featureCatalogue.filter((f) => f.group === g),
);

const metaOf = Object.fromEntries(
  featureCatalogue.map((f) => [f.key, f]),
) as Record<Feature, FeatureMeta>;
export function featureMeta(key: Feature): FeatureMeta {
  return metaOf[key];
}

export type CoreKey = "feeds" | "diapers" | "sleep";
// Home's order.
export const coreKeys: CoreKey[] = ["feeds", "diapers", "sleep"];

// Whole calendar months, the way a health nurse counts: a baby born on the
// 15th turns one month on the 15th.
export function ageMonths(birthDate: Date, now = new Date()): number {
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 +
    (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  return Math.max(0, months);
}

// The age bands (spec §The recommended set). A Norwegian barnehage child
// is one and stays in diapers until two or three, so diapers stay; feeds
// are what stops being logged. Pump, barnehage, vaccines, baths and notes
// are never recommended by age: a family knows if it needs those.
export function recommended(months: number): Feature[] {
  if (months < 4) return ["feeds", "sleep", "diapers", "measurements"];
  if (months < 12)
    return ["feeds", "sleep", "diapers", "measurements", "milestones", "play"];
  return ["sleep", "diapers", "medicine", "illness"];
}

export function recommendedByAge(key: Feature, months: number): boolean {
  return recommended(months).includes(key);
}

export function tracks(baby: Baby | undefined, key: Feature): boolean {
  return (baby?.features ?? []).includes(key);
}

// ANY baby in the family: the Family page's shared lists (medicines, the
// barnehage, …) stay while one child still uses them. True while the list
// is unknown, so nothing flashes away and back while it loads.
export function familyTracks(
  babies: Baby[] | undefined,
  key: Feature,
): boolean {
  if (!babies) return true;
  return babies.some((b) => tracks(b, key));
}

export type Tracking = {
  has: (key: Feature) => boolean;
  any: boolean;
  // Anything that lives behind the More button.
  anyMore: boolean;
};

export function tracking(baby: Baby | undefined): Tracking {
  const set = new Set<Feature>(baby?.features ?? []);
  return {
    has: (key) => set.has(key),
    any: set.size > 0,
    anyMore: features.some(
      (k) => set.has(k) && !(coreKeys as string[]).includes(k),
    ),
  };
}

export function useTracking(baby: Baby | undefined): Tracking {
  // The array is replaced on every babies refetch; key on its contents.
  const joined = (baby?.features ?? []).join(",");
  const id = baby?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `joined` stands for baby.features
  return useMemo(() => tracking(baby), [id, joined]);
}

export function otherKindFeature(kind: OtherKind): Feature {
  switch (kind) {
    case "note":
      return "notes";
    case "measurement":
      return "measurements";
    case "milestone":
      return "milestones";
    default:
      return kind;
  }
}

// The SPA's copy of internal/jobs/reminders.go featureForKind.
export function reminderKindFeature(kind: ReminderKind): Feature | null {
  switch (kind) {
    case "feed":
      return "feeds";
    case "diaper":
      return "diapers";
    case "pump":
      return "pump";
    case "medicine":
      return "medicine";
    default:
      return null;
  }
}

const otherKinds: OtherKind[] = [
  "medicine",
  "bath",
  "note",
  "milestone",
  "measurement",
  "pump",
];

// ?log= from a manifest shortcut or a push action (screens/Home.tsx).
export function logParamFeature(log: string): Feature | null {
  if (log === "feed") return "feeds";
  if (log === "diaper") return "diapers";
  if (log === "sleep") return "sleep";
  if ((otherKinds as string[]).includes(log))
    return otherKindFeature(log as OtherKind);
  return null;
}

export function enabledLabels(baby: Baby): string[] {
  return featureCatalogue
    .filter((f) => tracks(baby, f.key))
    .map((f) => f.label);
}
