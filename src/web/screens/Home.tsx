import { Baby as BabyIcon, Droplets, Milk, Moon, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ActiveSleepBanner } from "@/components/ActiveSleepBanner";
import { LogButton } from "@/components/LogButton";
import { StatusCard } from "@/components/StatusCard";
import { Button } from "@/components/ui/button";
import { DiaperSheet } from "@/components/sheets/DiaperSheet";
import { FeedSheet } from "@/components/sheets/FeedSheet";
import { SleepSheet } from "@/components/sheets/SleepSheet";
import { useSession } from "@/lib/auth-client";
import { useBabies, useFeeds, useSummary, useWakeSleep } from "@/lib/data";
import { t } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";
import { formatAge } from "@/lib/time";
import { toast } from "@/lib/toast";

type OpenSheet = "feed" | "diaper" | "sleep" | null;

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
  return t("solids");
}

export function HomeScreen() {
  const { data: session } = useSession();
  const babies = useBabies();
  const baby = babies.data?.[0];
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const { night } = useAppearance();
  const navigate = useNavigate();

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
    return <div className="min-h-dvh" />;
  }

  const s = summary.data;
  const active = s?.activeSleep ?? null;

  if (night) {
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
        <div>
          <h1 className="text-2xl font-extrabold text-ink">{baby.name}</h1>
          <p className="text-sm font-medium text-muted">
            {formatAge(new Date(baby.birthDate))}
          </p>
        </div>
        <div
          className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-base font-bold text-accent"
          title={session?.user.name}
        >
          {(session?.user.name ?? "?").slice(0, 1).toUpperCase()}
        </div>
      </header>

      <div className="space-y-3 pb-tabbar">
        {active && <ActiveSleepBanner session={active} />}

        {/* Status before action: last feed / last diaper at a glance */}
        <div className="grid grid-cols-1 gap-3">
          <StatusCard
            icon={Milk}
            label={t("Last feed")}
            time={s?.lastFeed ? new Date(s.lastFeed.time) : null}
            detail={s?.lastFeed ? feedDetail(s.lastFeed) : undefined}
            tintClass="text-feed"
            onClick={() => setSheet("feed")}
          />
          <StatusCard
            icon={Droplets}
            label={t("Last diaper")}
            time={s?.lastDiaper ? new Date(s.lastDiaper.time) : null}
            detail={s?.lastDiaper ? t(s.lastDiaper.type) : undefined}
            tintClass="text-diaper"
            onClick={() => setSheet("diaper")}
          />
          {!active && s?.lastSleep?.endTime && (
            <StatusCard
              icon={Moon}
              label={t("Last sleep")}
              time={new Date(s.lastSleep.endTime)}
              tintClass="text-sleep"
              onClick={() => setSheet("sleep")}
            />
          )}
        </div>

        {/* 2×2 log grid */}
        <div className="grid grid-cols-2 gap-3 pt-1">
          <LogButton
            icon={Milk}
            label={t("Feed")}
            tintClass="text-feed"
            onClick={() => setSheet("feed")}
          />
          <LogButton
            icon={Droplets}
            label={t("Diaper")}
            tintClass="text-diaper"
            onClick={() => setSheet("diaper")}
          />
          <LogButton
            icon={Moon}
            label={active ? t("Sleeping…") : t("Sleep")}
            tintClass="text-sleep"
            onClick={() => setSheet("sleep")}
            disabled={!!active}
          />
          <LogButton
            icon={Plus}
            label={t("More")}
            tintClass="text-growth"
            onClick={() => toast(t("More activity types come in phase 3"))}
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
    icon: typeof Moon,
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
        <BabyIcon className="mx-auto h-6 w-6 text-muted" />
        {activeSleepId
          ? nightAction(t("Wake"), Moon, () =>
              wakeSleep.mutate({ id: activeSleepId }),
            )
          : nightAction(t("Sleep"), Moon, () => setSheet("sleep"))}
        {nightAction(t("Feed"), Milk, () => setSheet("feed"))}
        {nightAction(t("Diaper"), Droplets, () => setSheet("diaper"))}
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
