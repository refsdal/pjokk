import { useSyncExternalStore } from "react";
import wakeWindows from "@/data/wake-windows.json";
import { ageInMonths } from "@/lib/growth";
import { t } from "@/lib/i18n";
import { formatClock } from "@/lib/time";

// The nap-window guide (issue #46): the one conclusion the Awake card left
// to the parent's mental arithmetic. Rule-based and honest — a typical
// wake window for the baby's age (data/wake-windows.json, cited there)
// added to the moment she last woke, shown as a WINDOW, never a
// prediction. It degrades to nothing (no line at all) whenever the inputs
// are missing or stale rather than guess. Client-side only.

type Row = {
  fromMonths: number;
  toMonths: number;
  minMin: number;
  maxMin: number;
};
const rows = wakeWindows.rows as Row[];

/** The typical wake window for an age, in minutes, or null past the table. */
export function wakeWindowFor(
  ageMonths: number,
): { minMin: number; maxMin: number } | null {
  if (ageMonths < 0) return null;
  const row = rows.find(
    (r) =>
      ageMonths >= r.fromMonths &&
      (ageMonths < r.toMonths ||
        (r === rows[rows.length - 1] && ageMonths <= r.toMonths)),
  );
  return row ? { minMin: row.minMin, maxMin: row.maxMin } : null;
}

export type NapWindow = {
  state: "upcoming" | "open" | "past";
  from: Date;
  to: Date;
};

// A wake older than this is not "the last wake" any more: nothing has been
// logged for half a day and the honest reading is no reading.
const STALE_WAKE_MS = 12 * 3600_000;

/** The nap window for a baby who woke at `wakeAt`, or null when there is
 *  nothing honest to say (no birth date, past the table, a stale wake). */
export function napWindow({
  birthDate,
  wakeAt,
  now = new Date(),
}: {
  birthDate: Date | null | undefined;
  wakeAt: Date | null | undefined;
  now?: Date;
}): NapWindow | null {
  if (!birthDate || !wakeAt) return null;
  if (now.getTime() - wakeAt.getTime() > STALE_WAKE_MS) return null;
  if (wakeAt.getTime() > now.getTime() + 60_000) return null;
  const window = wakeWindowFor(ageInMonths(birthDate, now));
  if (!window) return null;
  const from = new Date(wakeAt.getTime() + window.minMin * 60_000);
  const to = new Date(wakeAt.getTime() + window.maxMin * 60_000);
  const state = now < from ? "upcoming" : now <= to ? "open" : "past";
  return { state, from, to };
}

/** The Awake card's guide line. */
export function describeNapWindow(w: NapWindow): string {
  switch (w.state) {
    case "upcoming":
      return `${t("Nap window")} ${formatClock(w.from)}–${formatClock(w.to)}`;
    case "open":
      return `${t("In the nap window")} · ${t("until")} ${formatClock(w.to)}`;
    default:
      return t("Past the usual nap window");
  }
}

// --- The family's own anchor (issue #112) --------------------------------
//
// Past twelve months the cited table stops, because its source does, and no
// clinical source gives wake windows for toddlers (issue #112 has the
// search). It is also the age at which a barnehage's fixed midday nap, not
// a wake window, sets the rhythm. So a family can give the card its own
// number — "she naps at 11:30" — and when they have, the card says that
// instead of computing anything, at any age, weekends included, which is
// what keeps a Saturday in step with the barnehage's week.

export type UsualNap = { state: "upcoming" | "was"; at: Date };

// How long after the usual time the card keeps saying so. Past this the
// nap either happened unlogged or is not happening, and the line is noise.
const USUAL_NAP_LINGER_MS = 3 * 3600_000;
// A sleep that began this close before the usual time IS that nap.
const USUAL_NAP_EARLY_MS = 90 * 60_000;

/** The usual-nap line's state, or null when there is nothing to say: no
 *  anchor, the nap has been had (a sleep began around or after it today),
 *  or the time is long past. */
export function usualNap({
  minute,
  lastSleepStart,
  now = new Date(),
}: {
  minute: number | null | undefined;
  lastSleepStart: Date | null | undefined;
  now?: Date;
}): UsualNap | null {
  if (minute == null) return null;
  const at = new Date(now);
  at.setHours(0, minute, 0, 0);
  if (
    lastSleepStart &&
    lastSleepStart.getTime() >= at.getTime() - USUAL_NAP_EARLY_MS &&
    lastSleepStart.getTime() <= now.getTime()
  ) {
    return null;
  }
  if (now.getTime() < at.getTime()) return { state: "upcoming", at };
  if (now.getTime() - at.getTime() > USUAL_NAP_LINGER_MS) return null;
  return { state: "was", at };
}

export function describeUsualNap(n: UsualNap): string {
  return n.state === "upcoming"
    ? `${t("Usual nap")} ${formatClock(n.at)}`
    : `${t("Usual nap was")} ${formatClock(n.at)}`;
}

// --- Device preference: the guide can be switched off -------------------
// Per device, like night mode and the theme: a nursery tablet and a phone
// may legitimately differ, and it is a display choice, not family data.

const KEY = "pjokk.napGuide";

let enabled = true;
try {
  enabled = localStorage.getItem(KEY) !== "off";
} catch {
  // storage unavailable — the guide stays on
}

const listeners = new Set<() => void>();

export function setNapGuide(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // storage unavailable
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useNapGuide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => enabled,
  );
}
