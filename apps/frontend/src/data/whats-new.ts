import {
  IconBabyBottle,
  IconChartBar,
  IconMoon,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import type { GuideCard, WhatsNewEntry } from "@/lib/whats-new";

// The entries themselves. Content, not logic — the selection rules live in
// lib/whats-new.ts.
//
// HOW TO ADD ONE: append to `whatsNew` with the next seq, in the same PR as
// the feature it describes, and add its two strings to the nb dictionary in
// lib/i18n.ts (bun run check fails until you do). Never renumber, never
// reorder, never reuse a seq — see WhatsNewEntry.seq.
//
// DELIBERATELY NO BACKLOG (spec, "No backlog"): nothing is written here for
// a feature that shipped before this mechanism existed. A first run that
// listed every feature ever shipped would be the tutorial wall CLAUDE.md's
// information architecture bans.
export const whatsNew: WhatsNewEntry[] = [
  {
    seq: 1,
    version: "v0.48.0",
    title: t("A quiet note when something changes"),
    body: t(
      "New things now show up as one line here on Home. Tap to read them, or brush it away — everything stays under Settings.",
    ),
    icon: IconSparkles,
    tint: "text-accent",
  },
];

// The first run, for someone who arrived by invite and has never seen the
// app. Not generated from the entries above: a newcomer wants to know what
// the app is for, not what changed last Tuesday.
export const gettingStarted: GuideCard[] = [
  {
    key: "status",
    title: t("A glance, not a log"),
    body: t(
      "Home answers when she last ate, slept and was changed — before you tap anything.",
    ),
    icon: IconMoon,
    tint: "text-sleep",
  },
  {
    key: "log",
    title: t("Two taps to log"),
    body: t(
      "Open, save. Every form remembers the last one, and you can always fix the time afterwards.",
    ),
    icon: IconBabyBottle,
    tint: "text-feed",
  },
  {
    key: "together",
    title: t("Everyone sees the same thing"),
    body: t(
      "Whoever is with her can log it. Entries say who did the care, which is useful the morning after.",
    ),
    icon: IconUsers,
    tint: "text-accent",
  },
  {
    key: "more",
    title: t("The rest can wait"),
    body: t(
      "Timeline, Stats and Calendar are there when you want them. Nothing needs setting up first.",
    ),
    icon: IconChartBar,
    tint: "text-growth",
  },
];
