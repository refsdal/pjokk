import {
  IconBabyBottle,
  IconBabyCarriage,
  IconDiaper,
  IconMoon,
  IconPlus,
} from "@tabler/icons-react";
import { useState } from "react";
import type { PlayType } from "@pjokk/shared";
import { useNavigate } from "@tanstack/react-router";
import {
  ActivePlayBanner,
  ActiveSleepBanner,
} from "@/components/ActiveSessionBanner";
import { BabySwitcher } from "@/components/BabySwitcher";
import { InstallBanner } from "@/components/InstallBanner";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { LogButton } from "@/components/LogButton";
import { StatusCard } from "@/components/StatusCard";
import { Button } from "@/components/ui/button";
import { DiaperSheet } from "@/components/sheets/DiaperSheet";
import { FeedSheet } from "@/components/sheets/FeedSheet";
import { MoreSheet, OtherLogSheet } from "@/components/sheets/OtherLogSheet";
import { PlaySheet } from "@/components/sheets/PlaySheet";
import { SleepSheet } from "@/components/sheets/SleepSheet";
import { useQueryClient } from "@tanstack/react-query";
import {
  prefetchOtherLists,
  useFeeds,
  useMe,
  useSummary,
  useWakeSleep,
  type OtherKind,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatDuration } from "@/lib/time";
import { useAppearance } from "@/lib/appearance";

type OpenSheet = "feed" | "diaper" | "sleep" | "more" | "other" | "play" | null;

function feedDetail(feed: {
  type: string;
  amountMl: number | null;
  side: string | null;
  durationMin: number | null;
}): string {
  if (feed.type === "bottle") return `${feed.amountMl ?? "?"} ml`;
  if (feed.type === "breast")
    return [feed.side, feed.durationMin ? `${feed.durationMin} min` : null]
      .filter(Boolean)
      .join(" · ");
  return feed.amountMl != null ? `${feed.amountMl} g` : t("solids");
}

export function HomeScreen() {
  const me = useMe();
  const { babies, baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [otherKind, setOtherKind] = useState<OtherKind>("medicine");
  const [playType, setPlayType] = useState<PlayType>("tummy");
  const { night } = useAppearance();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (babies.isError) {
    return (
      <div className="flex min-h-dvh flex-col justify-center">
        <ErrorState onRetry={() => void babies.refetch()} />
      </div>
    );
  }

  if (babies.isSuccess && babies.data.length === 0) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
        <p className="text-lg font-bold">{t("No baby yet")}</p>
        <p className="text-sm text-muted">
          {t("Add your baby to start tracking.")}
        </p>
        <Button onClick={() => navigate({ to: "/welcome" })}>
          {t("Add baby")}
        </Button>
      </div>
    );
  }

  if (!baby) {
    return (
      <div className="flex min-h-dvh flex-col justify-center">
        <LoadingState />
      </div>
    );
  }

  const s = summary.data;
  const active = s?.activeSleep ?? null;
  const activePlay = s?.activePlay ?? null;

  // Never switch layouts while a sheet is open: the 22:00 auto-flip would
  // unmount an open More/Other sheet and discard whatever was typed.
  if (
    night &&
    (sheet === null ||
      sheet === "feed" ||
      sheet === "diaper" ||
      sheet === "sleep")
  ) {
    return (
      <NightHome
        babyId={baby.id}
        sheet={sheet}
        setSheet={setSheet}
        activeSleepId={active?.id ?? null}
        recentFeeds={feeds.data ?? []}
        lastDiaper={s?.lastDiaper ?? null}
      />
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      {/* Baby header */}
      <header className="flex items-center justify-between py-4">
        <BabySwitcher />
        <div
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-base font-bold text-accent"
          title={me.data?.name}
        >
          {(me.data?.name ?? "?").slice(0, 1).toUpperCase()}
        </div>
      </header>

      <div className="space-y-3 pb-tabbar">
        {active && <ActiveSleepBanner session={active} />}
        {activePlay && <ActivePlayBanner session={activePlay} />}

        {/* Status before action: last feed / last diaper at a glance */}
        <div className="grid grid-cols-1 gap-3">
          <StatusCard
            icon={IconBabyBottle}
            label={t("Last feed")}
            time={s?.lastFeed ? new Date(s.lastFeed.time) : null}
            detail={s?.lastFeed ? feedDetail(s.lastFeed) : undefined}
            sub={
              s
                ? `${s.today.feeds} ${t("feeds")} · ${s.today.intakeMl} ml${
                    s.today.solidsG > 0 ? ` · ${s.today.solidsG} g` : ""
                  } ${t("today")}`
                : undefined
            }
            tintClass="text-feed"
            onClick={() => setSheet("feed")}
          />
          <StatusCard
            icon={IconDiaper}
            label={t("Last diaper")}
            time={s?.lastDiaper ? new Date(s.lastDiaper.time) : null}
            detail={s?.lastDiaper ? t(s.lastDiaper.type) : undefined}
            sub={
              s
                ? `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}`
                : undefined
            }
            tintClass="text-diaper"
            onClick={() => setSheet("diaper")}
          />
          {!active && s?.lastSleep?.endTime && (
            <StatusCard
              icon={IconMoon}
              label={t("Last sleep")}
              time={new Date(s.lastSleep.endTime)}
              sub={`${formatDuration(s.today.sleepMin * 60_000)} ${t("today")}`}
              tintClass="text-sleep"
              onClick={() => setSheet("sleep")}
            />
          )}
        </div>

        {/* 2×2 log grid */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <LogButton
            icon={IconBabyBottle}
            label={t("Feed")}
            tintClass="text-feed"
            onClick={() => setSheet("feed")}
          />
          <LogButton
            icon={IconDiaper}
            label={t("Diaper")}
            tintClass="text-diaper"
            onClick={() => setSheet("diaper")}
          />
          <LogButton
            icon={IconMoon}
            label={active ? t("Sleeping…") : t("Sleep")}
            tintClass="text-sleep"
            onClick={() => setSheet("sleep")}
            disabled={!!active}
          />
          <LogButton
            icon={IconPlus}
            label={t("More")}
            tintClass="text-growth"
            onClick={() => {
              prefetchOtherLists(queryClient, baby.id);
              setSheet("more");
            }}
          />
        </div>
      </div>

      <FeedSheet
        open={sheet === "feed"}
        onOpenChange={(o) => setSheet(o ? "feed" : null)}
        babyId={baby.id}
        recentFeeds={feeds.data ?? []}
      />
      <DiaperSheet
        open={sheet === "diaper"}
        onOpenChange={(o) => setSheet(o ? "diaper" : null)}
        babyId={baby.id}
        lastDiaper={s?.lastDiaper ?? null}
      />
      <SleepSheet
        open={sheet === "sleep"}
        onOpenChange={(o) => setSheet(o ? "sleep" : null)}
        babyId={baby.id}
        lastLocation={s?.lastSleep?.location ?? null}
      />
      <MoreSheet
        open={sheet === "more"}
        onOpenChange={(o) => setSheet(o ? "more" : null)}
        onPick={(kind) => {
          setOtherKind(kind);
          setSheet("other");
        }}
        onPickPlay={(type) => {
          setPlayType(type);
          setSheet("play");
        }}
      />
      <OtherLogSheet
        open={sheet === "other"}
        onOpenChange={(o) => setSheet(o ? "other" : null)}
        babyId={baby.id}
        kind={otherKind}
      />
      <PlaySheet
        open={sheet === "play"}
        onOpenChange={(o) => setSheet(o ? "play" : null)}
        babyId={baby.id}
        type={playType}
      />

      {/* Day-mode Home only: night mode is three actions and nothing else. */}
      <InstallBanner />
    </div>
  );
}

// Night mode home: three actions only, everything in the bottom half,
// nothing bright (CLAUDE.md §6).
function NightHome({
  babyId,
  sheet,
  setSheet,
  activeSleepId,
  recentFeeds,
  lastDiaper,
}: {
  babyId: string;
  sheet: OpenSheet;
  setSheet: (s: OpenSheet) => void;
  activeSleepId: string | null;
  recentFeeds: Parameters<typeof FeedSheet>[0]["recentFeeds"];
  lastDiaper: Parameters<typeof DiaperSheet>[0]["lastDiaper"];
}) {
  const wakeSleep = useWakeSleep();
  const nightAction = (
    label: string,
    icon: typeof IconMoon,
    onClick: () => void,
  ) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex h-20 w-full items-center gap-4 rounded-xl2 border border-line bg-surface px-6 text-xl font-bold text-ink active:bg-surface-2"
      >
        <Icon className="h-7 w-7 text-accent" />
        {label}
      </button>
    );
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-end px-4 pb-tabbar">
      <div className="space-y-3 pb-4">
        <IconBabyCarriage className="mx-auto h-6 w-6 text-muted" />
        {activeSleepId
          ? nightAction(t("Wake"), IconMoon, () =>
              wakeSleep.mutate({ id: activeSleepId }),
            )
          : nightAction(t("Sleep"), IconMoon, () => setSheet("sleep"))}
        {nightAction(t("Feed"), IconBabyBottle, () => setSheet("feed"))}
        {nightAction(t("Diaper"), IconDiaper, () => setSheet("diaper"))}
      </div>

      <FeedSheet
        open={sheet === "feed"}
        onOpenChange={(o) => setSheet(o ? "feed" : null)}
        babyId={babyId}
        recentFeeds={recentFeeds}
      />
      <DiaperSheet
        open={sheet === "diaper"}
        onOpenChange={(o) => setSheet(o ? "diaper" : null)}
        babyId={babyId}
        lastDiaper={lastDiaper}
      />
      <SleepSheet
        open={sheet === "sleep"}
        onOpenChange={(o) => setSheet(o ? "sleep" : null)}
        babyId={babyId}
        lastLocation={null}
      />
    </div>
  );
}
