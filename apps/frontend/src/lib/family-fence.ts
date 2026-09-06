// Family fence (spec §5). The server keeps the active family on the
// session; the client keeps caches keyed without one. Whenever the family
// behind the session changes without this tab's switch flow running —
// another tab, another device, a crash mid-switch — the cache must go. The
// shell compares what /api/me reports with the last family this device
// rendered, and resets on a mismatch.

const KEY = "pjokk.familyId";

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
