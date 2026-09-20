import type { Feature } from "@pjokk/shared";
import type { TablerIcon } from "@tabler/icons-react";

// What's new, and a first run (spec
// docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
// The pure half: which entries a person is shown, and what dismissal marks.
// Content lives in data/whats-new.ts; nothing here knows what any entry says.

export type WhatsNewEntry = {
  /**
   * Monotonic. APPEND ONLY — never reorder, never reuse, never renumber. A
   * person's marker is "the highest seq I have seen", so changing what a
   * number means re-shows or silently hides entries for everyone sitting
   * on it.
   */
  seq: number;
  /** Display text only. Never compared — see seq. */
  version: string;
  title: string;
  body: string;
  /**
   * Relevance gate. An entry naming a feature is skipped entirely for a
   * family that tracks it on no baby: announcing the barnehage handover to
   * a family without barnehage is noise, and noise is what teaches people
   * to ignore the channel. Omitted means always shown.
   */
  feature?: Feature;
  icon: TablerIcon;
  tint: string;
};

/** A card in the first-run carousel. No seq: it is not a release. */
export type GuideCard = {
  key: string;
  title: string;
  body: string;
  icon: TablerIcon;
  tint: string;
};

/**
 * The entries this person has not seen and this family can use, newest
 * first. `tracks` is the family-wide union — pass
 * `(k) => familyTracks(babies.data, k)` (lib/tracking.ts), which answers
 * true while the babies are still loading, so nothing flashes.
 */
export function pending(
  entries: WhatsNewEntry[],
  seq: number,
  tracks: (key: Feature) => boolean,
): WhatsNewEntry[] {
  return entries
    .filter((e) => e.seq > seq && (!e.feature || tracks(e.feature)))
    .sort((a, b) => b.seq - a.seq);
}

/**
 * The marker to write on dismissal, over the UNFILTERED list: a family that
 * does not use barnehage still counts the barnehage entry as seen, or
 * switching the feature on six months later would replay a stale
 * announcement as though it were news.
 */
export function highestSeq(entries: WhatsNewEntry[]): number {
  return entries.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
}
