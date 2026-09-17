import type { Stats, StatsNight } from "@pjokk/shared";

// The Stats screen's night arithmetic (issue #50), kept pure for the unit
// test. The server already decided which night each session belongs to;
// this only picks "last night" and its trend.

export type LastNight = {
  night: StatsNight & { longestStretchMin: number; wakings: number };
  /** Minutes vs the mean of the earlier nights in the window that have data; null with nothing to compare to. */
  deltaMin: number | null;
};

/** The newest night with a night session, and how its longest stretch compares. */
export function lastNight(nights: StatsNight[]): LastNight | null {
  let idx = -1;
  for (let i = nights.length - 1; i >= 0; i--) {
    if (nights[i]!.longestStretchMin != null) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const night = nights[idx] as LastNight["night"];
  const earlier = nights
    .slice(0, idx)
    .map((n) => n.longestStretchMin)
    .filter((v): v is number => v != null);
  const deltaMin =
    earlier.length > 0
      ? Math.round(
          night.longestStretchMin -
            earlier.reduce((a, b) => a + b, 0) / earlier.length,
        )
      : null;
  return { night, deltaMin };
}

/** "4 h 20 min" / "45 min" / "0 min". */
export function formatMinutes(min: number, h = "h", m = "min"): string {
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours === 0) return `${rest} ${m}`;
  return rest === 0 ? `${hours} ${h}` : `${hours} ${h} ${rest} ${m}`;
}

/**
 * The Sleep card's nap sub-line ("Nap 1 h 15 min · 3.2 naps"), or null when
 * no nap ended inside the window — a "0 min" nap is noise, not a status.
 * Worded by the caller so the strings stay in the screen, next to the
 * other translated copy.
 */
export function napLine(
  avgNapMin: number,
  avgNaps: number,
  fmt: (min: number) => string,
  labels: { nap: string; naps: string },
): string | null {
  if (avgNapMin <= 0 || avgNaps <= 0) return null;
  return `${labels.nap} ${fmt(avgNapMin)} · ${avgNaps} ${labels.naps}`;
}

// Barnehage days against home days (issue #111). The server averaged; this
// only words it. A figure the group has no data for is left out of its line
// rather than shown as a zero.
export type DayGroup = NonNullable<Stats["daycareSplit"]>["daycare"];

const pad2 = (n: number) => String(n).padStart(2, "0");
export const clockOfMinutes = (min: number): string =>
  `${pad2(Math.floor(min / 60) % 24)}:${pad2(min % 60)}`;

export function dayGroupLine(
  g: DayGroup,
  fmt: (min: number) => string,
  labels: { nap: string; bed: string; night: string },
): string {
  return [
    `${labels.nap} ${fmt(g.avgNapMin)}`,
    g.avgBedtimeMin == null
      ? null
      : `${labels.bed} ${clockOfMinutes(g.avgBedtimeMin)}`,
    g.avgNightSleepMin == null
      ? null
      : `${labels.night} ${fmt(g.avgNightSleepMin)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Ill days (issue #127): "6 of 30 days · 2 episodes" under an "Ill days"
// label, or null when the window has none — a healthy month needs no row.
// The label is the card's, not part of the line: set in the app's typeface
// a leading "Ill" reads as the Roman numeral III. The words are passed in
// so the strings stay in the screen, next to the other translated copy.
export function illLine(
  illDays: number,
  illEpisodes: number,
  windowDays: number,
  labels: { of: string; days: string; episode: string; episodes: string },
): string | null {
  if (illDays <= 0) return null;
  const episodes = `${illEpisodes} ${illEpisodes === 1 ? labels.episode : labels.episodes}`;
  return `${illDays} ${labels.of} ${windowDays} ${labels.days} · ${episodes}`;
}
