import type { SleepLog, Summary } from "@pjokk/shared";
import { t } from "./i18n";

// How Home and the kiosk word a baby's sleep. A nap is any session NOT
// typed night — untyped sessions are the two-tap happy path — the same
// split the server uses for today.naps and /api/stats' avgNaps, so a night
// never counts among the naps and is never called one.

export function sleepNoun(type: SleepLog["type"] | undefined): string {
  return type === "night" ? t("night sleep") : t("nap");
}

/**
 * The awake card's sub-line: "2 naps · 1:45 today · night 10:30". Before
 * the first nap there are no minutes to show ("0 naps today"); the night
 * part is left out when the server has no recent night (lastNightMin null).
 */
export function napsLine(
  today: Pick<Summary["today"], "naps" | "napMin">,
  lastNightMin: number | null,
  fmt: (min: number) => string,
): string {
  const naps =
    today.naps === 0
      ? `0 ${t("naps")} ${t("today")}`
      : `${today.naps} ${today.naps === 1 ? t("nap") : t("naps")} · ${fmt(today.napMin)} ${t("today")}`;
  return lastNightMin == null
    ? naps
    : `${naps} · ${t("night")} ${fmt(lastNightMin)}`;
}
