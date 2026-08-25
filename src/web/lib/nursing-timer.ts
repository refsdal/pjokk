// A dead-simple persisted nursing timer: accumulated seconds per side plus
// at most one running side. Survives the sheet closing or the PWA being
// backgrounded; cleared when a feed is saved.
const KEY = "pjokk.nursing";

export type NursingTimer = {
  running: "left" | "right" | null;
  startedAt: number | null;
  leftSec: number;
  rightSec: number;
};

const empty: NursingTimer = {
  running: null,
  startedAt: null,
  leftSec: 0,
  rightSec: 0,
};

export function loadNursing(): NursingTimer {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as NursingTimer) } : empty;
  } catch {
    return empty;
  }
}

export function saveNursing(t: NursingTimer) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* storage unavailable — timer is best-effort */
  }
}

export function clearNursing() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Seconds for a side including a currently-running stretch. */
export function sideSeconds(
  t: NursingTimer,
  side: "left" | "right",
  now = Date.now(),
): number {
  const base = side === "left" ? t.leftSec : t.rightSec;
  return t.running === side && t.startedAt
    ? base + Math.floor((now - t.startedAt) / 1000)
    : base;
}
