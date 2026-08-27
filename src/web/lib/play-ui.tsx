import {
  IconBallBasketball,
  IconStretching,
  IconWalk,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import type { PlayType } from "@shared/schemas";

// Play reuses existing category tints rather than introducing a colour —
// icons and badges only, never backgrounds (CLAUDE.md §7).
export const playKindMeta: Record<
  PlayType,
  { label: string; icon: TablerIcon; tint: string }
> = {
  tummy: { label: "Tummy time", icon: IconStretching, tint: "text-growth" },
  walk: { label: "Walk", icon: IconWalk, tint: "text-accent" },
  play: { label: "Play", icon: IconBallBasketball, tint: "text-diaper" },
};

export const playTypeOrder: PlayType[] = ["tummy", "walk", "play"];
