import { useEffect, useState } from "react";

// Viewport tiers (spec §1). The CSS side is Tailwind's `md:` / `xl:`
// classes; this is the JS side for the three things a class cannot do —
// the vaul drawer direction, gating the wide-only Recent query, and the
// sheet's latched direction. The numbers are Tailwind's defaults and must
// stay in step with them.
export type Tier = "compact" | "regular" | "wide";

export const REGULAR_MIN = 768;
export const WIDE_MIN = 1280;

export function tierFor(width: number): Tier {
  if (width >= WIDE_MIN) return "wide";
  if (width >= REGULAR_MIN) return "regular";
  return "compact";
}

// From the two min-width media queries, so the answer agrees with the CSS
// even where innerWidth and the media-query viewport differ (scrollbars,
// zoom). A `wide` match without a `regular` match cannot happen on a sane
// engine; treat it as compact rather than trust half of a contradiction.
export function tierFromMatches(regular: boolean, wide: boolean): Tier {
  if (!regular) return "compact";
  return wide ? "wide" : "regular";
}

const REGULAR_QUERY = `(min-width: ${REGULAR_MIN}px)`;
const WIDE_QUERY = `(min-width: ${WIDE_MIN}px)`;

function currentTier(): Tier {
  if (typeof window === "undefined" || !window.matchMedia) return "compact";
  return tierFromMatches(
    window.matchMedia(REGULAR_QUERY).matches,
    window.matchMedia(WIDE_QUERY).matches,
  );
}

export function useTier(): Tier {
  const [tier, setTier] = useState<Tier>(currentTier);
  useEffect(() => {
    const queries = [
      window.matchMedia(REGULAR_QUERY),
      window.matchMedia(WIDE_QUERY),
    ];
    const apply = () => setTier(currentTier());
    apply();
    for (const q of queries) q.addEventListener("change", apply);
    return () => {
      for (const q of queries) q.removeEventListener("change", apply);
    };
  }, []);
  return tier;
}
