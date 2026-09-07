// Family fence (spec §5). The server keeps the active family on the
// session; the client keeps caches keyed without one. Whenever the family
// behind the session changes without this tab's switch flow running —
// another tab, another device, a crash mid-switch — the cache must go. The
// shell compares what /api/me reports with the last family this device
// rendered, and resets on a mismatch.

const KEY = "pjokk.familyId";
const DISCARDED_KEY = "pjokk.familyFence.discarded";

export type FenceVerdict = "recorded" | "same" | "changed";

export function judgeFamily(
  stored: string | null,
  current: string | null,
): FenceVerdict {
  // No family yet (Welcome) — nothing to fence, and nothing to forget.
  if (current === null) return "same";
  if (stored === null) return "recorded";
  return stored === current ? "same" : "changed";
}

export function readFence(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeFence(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable
  }
}

export function clearFence(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

// A fence trip that finds paused (offline-queued) mutations discards them —
// the server has already switched families by the time this device notices,
// so a write queued for the old family can never be replayed. Recorded here
// and consumed once, after the reload, so the shell can tell the person
// rather than silently dropping their entry.
export function recordDiscarded(n: number): void {
  if (n <= 0) return;
  try {
    localStorage.setItem(DISCARDED_KEY, String(n));
  } catch {
    // storage unavailable
  }
}

export function takeDiscarded(): number {
  try {
    const raw = localStorage.getItem(DISCARDED_KEY);
    localStorage.removeItem(DISCARDED_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
