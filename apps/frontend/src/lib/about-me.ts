import type { FeedLog, SleepLog } from "@pjokk/shared";

// "About <name>" (issue #109): the one page a barnehage asks every family
// for before tilvenning, built from what the family has already logged.
// This file is the summarising half — pure functions over the ordinary list
// reads, so "usual" can be tested without a browser or a PDF.
//
// "Usual" is a MEDIAN, never a mean: one 04:30 start to the day or one nap
// in the car at 16:00 must not move the line a stranger will plan her day
// by. And every figure needs a few days behind it before it is printed —
// two naps are an anecdote, not a routine.

export const ABOUT_WINDOW_DAYS = 14;
const MIN_SAMPLES = 3;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// Minutes after local midnight; evening times before 04:00 belong to the
// previous evening, so a 23:50 and a 00:10 bedtime average to midnight and
// not to noon.
const clockMinutes = (iso: string, eveningWrap = false): number => {
  const d = new Date(iso);
  const m = d.getHours() * 60 + d.getMinutes();
  return eveningWrap && m < 4 * 60 ? m + 24 * 60 : m;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** Rounded to five minutes: "usually around 11:35" is what a median means. */
export function clockLabel(minutes: number): string {
  const r = Math.round(minutes / 5) * 5;
  const m = ((r % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const mode = (xs: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  for (const [k, n] of counts)
    if (best === null || n > counts.get(best)!) best = k;
  return best;
};

export type SleepRoutine = {
  // Minutes after midnight, or null when there are too few days to say.
  wakeUp: number | null;
  bedtime: number | null;
  napsPerDay: number | null;
  napStart: number | null;
  napMinutes: number | null;
  napLocation: string | null;
};

const within = (iso: string, now: Date) =>
  now.getTime() - new Date(iso).getTime() <= ABOUT_WINDOW_DAYS * 86_400_000;

export function sleepRoutine(
  sleeps: SleepLog[],
  now = new Date(),
): SleepRoutine {
  const done = sleeps.filter((s) => s.endTime && within(s.startTime, now));
  const nights = done.filter((s) => s.type === "night");
  const naps = done.filter((s) => s.type === "nap");

  // The night's LAST waking is the start of the day: a night logged in two
  // stretches ends when the second one does.
  const lastWakeByDay = new Map<string, number>();
  for (const n of nights) {
    const k = dayKey(n.endTime!);
    const m = clockMinutes(n.endTime!);
    if (m >= 4 * 60 && m <= 11 * 60)
      lastWakeByDay.set(k, Math.max(lastWakeByDay.get(k) ?? 0, m));
  }
  // …and its FIRST start is bedtime.
  const bedByEvening = new Map<string, number>();
  for (const n of nights) {
    const m = clockMinutes(n.startTime, true);
    if (m < 16 * 60) continue; // a "night" begun in the afternoon is a mislabel
    const d = new Date(n.startTime);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    const k = dayKey(d.toISOString());
    bedByEvening.set(k, Math.min(bedByEvening.get(k) ?? Infinity, m));
  }

  const napDays = new Map<string, number>();
  for (const n of naps)
    napDays.set(
      dayKey(n.startTime),
      (napDays.get(dayKey(n.startTime)) ?? 0) + 1,
    );
  // The day's longest nap is "the nap" a barnehage plans around.
  const mainNapByDay = new Map<string, SleepLog>();
  const len = (s: SleepLog) =>
    new Date(s.endTime!).getTime() - new Date(s.startTime).getTime();
  for (const n of naps) {
    const k = dayKey(n.startTime);
    const cur = mainNapByDay.get(k);
    if (!cur || len(n) > len(cur)) mainNapByDay.set(k, n);
  }
  const mains = [...mainNapByDay.values()];

  const enough = <T>(xs: T[]) => xs.length >= MIN_SAMPLES;
  const wakes = [...lastWakeByDay.values()];
  const beds = [...bedByEvening.values()];
  return {
    wakeUp: enough(wakes) ? median(wakes) : null,
    bedtime: enough(beds) ? median(beds) : null,
    napsPerDay: enough([...napDays.values()])
      ? median([...napDays.values()])
      : null,
    napStart: enough(mains)
      ? median(mains.map((n) => clockMinutes(n.startTime)))
      : null,
    napMinutes: enough(mains)
      ? median(mains.map((n) => len(n) / 60_000))
      : null,
    napLocation: enough(mains)
      ? mode(mains.map((n) => n.location).filter((l): l is string => !!l))
      : null,
  };
}

export type FoodRoutine = {
  bottlesPerDay: number | null;
  bottleMl: number | null;
  breastPerDay: number | null;
  mealsPerDay: number | null;
  // Most often first, at most eight: what she actually eats.
  foods: string[];
  // Every food ever logged with a reaction, whatever its date: the one list
  // on the page where old information is still information.
  reactions: string[];
};

export function foodRoutine(feeds: FeedLog[], now = new Date()): FoodRoutine {
  const recent = feeds.filter((f) => within(f.time, now));
  const perDay = (type: FeedLog["type"]): number | null => {
    const days = new Map<string, number>();
    for (const f of recent)
      if (f.type === type)
        days.set(dayKey(f.time), (days.get(dayKey(f.time)) ?? 0) + 1);
    const counts = [...days.values()];
    return counts.length >= MIN_SAMPLES ? median(counts) : null;
  };
  const bottles = recent
    .filter((f) => f.type === "bottle" && f.amountMl != null)
    .map((f) => f.amountMl!);
  const foodCounts = new Map<string, number>();
  for (const f of recent) {
    if (f.type !== "solids" || !f.food) continue;
    const name = f.food.trim();
    if (name) foodCounts.set(name, (foodCounts.get(name) ?? 0) + 1);
  }
  const reactions = new Set<string>();
  for (const f of feeds)
    if (f.type === "solids" && f.reaction && f.food?.trim())
      reactions.add(f.food.trim());
  return {
    bottlesPerDay: perDay("bottle"),
    bottleMl: bottles.length >= MIN_SAMPLES ? median(bottles) : null,
    breastPerDay: perDay("breast"),
    mealsPerDay: perDay("solids"),
    foods: [...foodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name]) => name),
    reactions: [...reactions].sort((a, b) => a.localeCompare(b)),
  };
}

// ---- the page, as sections of lines ---------------------------------------
//
// ONE list feeds both the preview in Settings and the PDF, so what a parent
// ticks is exactly what gets printed. A line is a label and a value; a
// section with no lines is not on the page at all — "Sleep: unknown" helps
// nobody.

export type AboutSectionKey =
  | "family"
  | "sleep"
  | "food"
  | "medicines"
  | "contacts";
export type AboutLine = { label: string; value: string };
export type AboutSection = {
  key: AboutSectionKey;
  title: string;
  lines: AboutLine[];
};

export type AboutInput = {
  about: {
    comfort: string | null;
    fallsAsleep: string | null;
    diet: string | null;
    other: string | null;
  };
  sleep: SleepRoutine;
  food: FoodRoutine;
  medicines: {
    name: string;
    defaultAmount: number | null;
    unit: string | null;
    minIntervalMin: number | null;
    archived: boolean;
  }[];
  contacts: { name: string; role: string | null; phone: string | null }[];
  volume: (ml: number) => string;
  // The translate function is passed in so this file stays importable from
  // a test without the i18n module's browser reads.
  t: (s: string) => string;
};

const duration = (min: number, t: AboutInput["t"]): string => {
  const r = Math.round(min / 5) * 5;
  const h = Math.floor(r / 60);
  const m = r % 60;
  if (h === 0) return `${m} ${t("min")}`;
  return m === 0 ? `${h} ${t("h")}` : `${h} ${t("h")} ${m} ${t("min")}`;
};

const count = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);

export function aboutSections(i: AboutInput): AboutSection[] {
  const { t } = i;
  const line = (
    label: string,
    value: string | null | undefined,
  ): AboutLine[] => (value ? [{ label: t(label), value }] : []);

  const sections: AboutSection[] = [
    {
      key: "family",
      title: t("From us"),
      lines: [
        ...line("Comfort items", i.about.comfort),
        ...line("Falls asleep", i.about.fallsAsleep),
        ...line("Allergies and diet", i.about.diet),
        ...line("Also worth knowing", i.about.other),
      ],
    },
    {
      key: "sleep",
      title: t("Sleep, as logged the last two weeks"),
      lines: [
        ...line(
          "Usually wakes",
          i.sleep.wakeUp === null ? null : clockLabel(i.sleep.wakeUp),
        ),
        ...line(
          "Usual bedtime",
          i.sleep.bedtime === null ? null : clockLabel(i.sleep.bedtime),
        ),
        ...line(
          "Naps a day",
          i.sleep.napsPerDay === null ? null : count(i.sleep.napsPerDay),
        ),
        ...line(
          "The long nap",
          i.sleep.napStart === null || i.sleep.napMinutes === null
            ? null
            : `${t("around")} ${clockLabel(i.sleep.napStart)}, ${duration(i.sleep.napMinutes, t)}`,
        ),
        ...line("Usually naps in", i.sleep.napLocation),
      ],
    },
    {
      key: "food",
      title: t("Food, as logged the last two weeks"),
      lines: [
        ...line(
          "Meals a day",
          i.food.mealsPerDay === null ? null : count(i.food.mealsPerDay),
        ),
        ...line(
          "Bottles a day",
          i.food.bottlesPerDay === null
            ? null
            : `${count(i.food.bottlesPerDay)}${i.food.bottleMl === null ? "" : `, ${t("around")} ${i.volume(i.food.bottleMl)}`}`,
        ),
        ...line(
          "Breastfeeds a day",
          i.food.breastPerDay === null ? null : count(i.food.breastPerDay),
        ),
        ...line("Eats", i.food.foods.join(", ")),
        ...line("Has reacted to", i.food.reactions.join(", ")),
      ],
    },
    {
      key: "medicines",
      title: t("Medicines and supplements"),
      lines: i.medicines
        .filter((m) => !m.archived)
        .map((m) => ({
          label: m.name,
          value:
            [
              m.defaultAmount === null
                ? null
                : `${m.defaultAmount} ${m.unit ?? ""}`.trim(),
              m.minIntervalMin === null
                ? null
                : `${t("at least")} ${duration(m.minIntervalMin, t)} ${t("apart")}`,
            ]
              .filter(Boolean)
              .join(", ") || "—",
        })),
    },
    {
      key: "contacts",
      title: t("Contacts"),
      lines: i.contacts
        .filter((c) => c.phone)
        .map((c) => ({
          label: c.role ? `${c.name} (${c.role})` : c.name,
          value: c.phone!,
        })),
    },
  ];
  return sections.filter((s) => s.lines.length > 0);
}

/** File name: pjokk-<baby>-about.pdf, ASCII-safe (the report's slug rule). */
export function aboutFilename(babyName: string): string {
  const slug =
    babyName
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/æ/g, "ae")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "baby";
  return `pjokk-${slug}-about.pdf`;
}
