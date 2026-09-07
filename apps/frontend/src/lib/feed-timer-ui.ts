import type { FeedTimer } from "@pjokk/shared";

// Reading a shared nursing / pump timer (issue #44). The server banks
// seconds per side at every switch, pause and stop; between those moments
// the client adds the running stretch itself, from the server's
// sideStartedAt. Pure functions so both the sheet and the Home banner say
// the same number, and so the rules are testable without React.

/** Seconds on one side, including the stretch running right now. "both"
 *  (a pump timer) banks into left, as the server does. */
export function sideSeconds(
  timer: FeedTimer,
  side: "left" | "right",
  now = Date.now(),
): number {
  const base = side === "left" ? timer.leftSec : timer.rightSec;
  if (!timer.runningSide || !timer.sideStartedAt) return base;
  const banksInto = timer.runningSide === "right" ? "right" : "left";
  if (banksInto !== side) return base;
  const started = new Date(timer.sideStartedAt).getTime();
  return base + Math.max(0, Math.floor((now - started) / 1000));
}

export function totalSeconds(timer: FeedTimer, now = Date.now()): number {
  return sideSeconds(timer, "left", now) + sideSeconds(timer, "right", now);
}

/** Whole minutes for a side's seconds — 0 when nothing accrued, otherwise
 *  at least 1 (a 20-second latch still registers). The server applies the
 *  same rule on stop, so the sheet's steppers and the logged row agree. */
export function minutesFromSeconds(sec: number): number {
  return sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0;
}

export function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
