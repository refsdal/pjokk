import { useEffect, useState } from "react";
import type { SleepLog, Summary } from "@pjokk/shared";

// Resume: reopen a sleep that was ended by mistake — Wake tapped when she
// was still asleep, or had gone straight back down. It clears the end time
// of the SAME row (PATCH endTime: null), so the session stays one
// continuous sleep and the night's wakings do not count a waking that never
// happened. A real waking followed by more sleep is a new session, which
// Sleep already logs.

// How long after a wake the status surfaces (Home, night Home, kiosk) offer
// Resume. Past it, the button is noise and a mis-tap waiting to happen; the
// edit sheet still offers it on the newest sleep.
export const RESUME_WINDOW_MS = 30 * 60_000;

type SleepState = Pick<Summary, "activeSleep" | "lastSleep">;

/** The sleep a Resume on the status surfaces would reopen, or null. */
export function resumableSleep(
  s: SleepState | undefined,
  now: Date,
): SleepLog | null {
  const last = s?.lastSleep;
  if (!s || s.activeSleep || !last?.endTime) return null;
  // A wake stamped a little ahead of this device's clock reads as negative
  // elapsed time; it is still a wake that just happened.
  return now.getTime() - new Date(last.endTime).getTime() <= RESUME_WINDOW_MS
    ? last
    : null;
}

/**
 * Whether the edit sheet may offer Resume on `edit`: only the newest sleep,
 * only once it has ended, and only while nothing else is running. The server
 * refuses a second running session (409) but not an overlap, and reopening
 * an older sleep would run it across the newer one.
 */
export function canResumeEdit(
  edit: SleepLog,
  s: SleepState | undefined,
): boolean {
  return (
    !!s &&
    !s.activeSleep &&
    edit.endTime !== null &&
    s.lastSleep?.id === edit.id
  );
}

/**
 * resumableSleep, kept current: re-renders once when the window closes so
 * the button disappears without waiting for the next summary refetch.
 */
export function useResumableSleep(s: SleepState | undefined): SleepLog | null {
  const [now, setNow] = useState(() => new Date());
  const lastEnd = s?.lastSleep?.endTime ?? null;
  useEffect(() => {
    // A new wake (from this device or another) arrives with the summary:
    // judge it against a fresh clock, then once more when its window closes.
    setNow(new Date());
    if (!lastEnd) return;
    const left = new Date(lastEnd).getTime() + RESUME_WINDOW_MS - Date.now();
    if (left < 0) return;
    const id = setTimeout(() => setNow(new Date()), left + 1000);
    return () => clearTimeout(id);
  }, [lastEnd]);
  return resumableSleep(s, now);
}
