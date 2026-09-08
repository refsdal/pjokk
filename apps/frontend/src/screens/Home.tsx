import {
  IconBabyBottle,
  IconBabyCarriage,
  IconDiaper,
  IconMoon,
  IconTemperature,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type {
  HelpRequest,
  MeasurementType,
  PlayType,
  SleepLog,
} from "@pjokk/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ActiveFeedBanner,
  ActivePlayBanner,
  ActivePumpBanner,
  ActiveSleepBanner,
} from "@/components/ActiveSessionBanner";
import { Avatar } from "@/components/Avatar";
import { BabySwitcher } from "@/components/BabySwitcher";
import { HelpCard } from "@/components/HelpCard";
import { InstallBanner } from "@/components/InstallBanner";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { HomeActions } from "@/components/HomeActions";
import { StatusCard } from "@/components/StatusCard";
import {
  showsTemperatureCard,
  temperatureStatus,
  temperatureTrend,
} from "@/lib/measurements";
import { TemperatureSparkline } from "@/components/TemperatureSparkline";
import { useMeasurements } from "@/lib/data/other";
import type { TemperatureStatus, TemperatureTrend } from "@/lib/measurements";
import { Button } from "@/components/ui/button";
import { AccountSheet } from "@/components/sheets/AccountSheet";
import { DiaperSheet } from "@/components/sheets/DiaperSheet";
import { FeedSheet } from "@/components/sheets/FeedSheet";
import { HelpSheet } from "@/components/sheets/HelpSheet";
import {
  MoreSheet,
  moreActions,
  OtherLogSheet,
} from "@/components/sheets/OtherLogSheet";
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
import { describeNapWindow, napWindow, useNapGuide } from "@/lib/nap-window";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatDuration, formatElapsed } from "@/lib/time";
import { useAppearance } from "@/lib/appearance";
import { cn, focusRing } from "@/lib/utils";
import {
  formatMeasurementIn,
  formatVolume,
  type Units,
  useUnits,
} from "@/lib/units";

const otherKinds: OtherKind[] = [
  "medicine",
  "bath",
  "note",
  "milestone",
  "measurement",
  "pump",
];
const isOtherKind = (v: string): v is OtherKind =>
  (otherKinds as string[]).includes(v);

type OpenSheet =
  | "feed"
  | "diaper"
  | "sleep"
  | "sleep-edit"
  | "more"
  | "other"
  | "play"
  | "help"
  | "account"
  | null;

function feedDetail(
  feed: {
    type: string;
    amountMl: number | null;
    side: string | null;
    durationMin: number | null;
  },
  units: Units,
): string {
  if (feed.type === "bottle")
    return feed.amountMl == null ? "?" : formatVolume(feed.amountMl, units);
  if (feed.type === "breast")
    return [feed.side, feed.durationMin ? `${feed.durationMin} min` : null]
      .filter(Boolean)
      .join(" · ");
  return feed.amountMl != null ? `${feed.amountMl} g` : t("solids");
}

// Colour carries the status, the arrow carries the direction. Both, because
// colour alone fails for red-green colour blindness — and red/green is
// precisely the pair that is indistinguishable — and because night mode
// collapses all three statuses onto its amber ramp, leaving the arrow as the
// only signal there.
const STATUS_TINT: Record<TemperatureStatus, string> = {
  ok: "text-ok",
  caution: "text-caution",
  alarm: "text-danger",
};
const TREND_ARROW: Record<TemperatureTrend, string> = {
  rising: "↑",
  falling: "↓",
  flat: "→",
  unknown: "",
};
const TREND_LABEL: Record<TemperatureTrend, string> = {
  rising: "Fever, rising",
  falling: "Fever, easing",
  flat: "Fever, steady",
  unknown: "Fever",
};

export function HomeScreen() {
  const me = useMe();
  const units = useUnits();
  const { babies, baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  // Measurements are rare — a handful per baby over months — so the existing
  // list endpoint is cheaper than teaching /api/summary to carry a series.
  const measurements = useMeasurements(baby?.id);
  const measurementRows = measurements.data ?? [];
  const tempTrend = temperatureTrend(measurementRows);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [otherKind, setOtherKind] = useState<OtherKind>("medicine");
  // Which measurement type the log sheet opens on. The More picker leaves it
  // at weight; the temperature card sets it, so tapping a fever does not land
  // the user on a weight stepper.
  const [measurementType, setMeasurementType] =
    useState<MeasurementType>("weight");
  const [playType, setPlayType] = useState<PlayType>("tummy");
  // The pump banner's Stop opens the pump sheet in "stop the timer" mode;
  // the More picker opens it in the ordinary log mode.
  const [pumpStop, setPumpStop] = useState(false);
  // The running session as it was when tapped. A snapshot rather than the
  // live summary value so a Wake from another device mid-edit cannot turn
  // the open edit sheet into a "start sleep" sheet under the user's thumb.
  const [editSleep, setEditSleep] = useState<SleepLog | null>(null);
  const { night } = useAppearance();
  const napGuide = useNapGuide();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The unfolded tiles at md and up (components/HomeActions.tsx) — the
  // same list the More sheet renders on the phone, with the same handlers.
  const actions = moreActions({
    onPick: (kind) => {
      setOtherKind(kind);
      setPumpStop(false);
      setMeasurementType("weight");
      setSheet("other");
    },
    onPickPlay: (type) => {
      setPlayType(type);
      setSheet("play");
    },
    onPickHelp: () => setSheet("help"),
    onVaccines: () => void navigate({ to: "/vaccines" }),
  });
  // ?log= from a manifest shortcut or a push action (issue #51): open that
  // sheet once the baby is known, then drop the param so a reload or a
  // back-swipe does not reopen it.
  const { log } = useSearch({ strict: false }) as { log?: string };
  useEffect(() => {
    if (!log || !baby) return;
    if (log === "feed" || log === "diaper" || log === "sleep") {
      setSheet(log);
    } else if (isOtherKind(log)) {
      setOtherKind(log);
      setPumpStop(false);
      setMeasurementType("weight");
      setSheet("other");
    }
    void navigate({ to: "/home", search: {}, replace: true });
  }, [log, baby, navigate]);

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
  const activeFeed = s?.activeFeed ?? null;
  const activePump = s?.activePump ?? null;
  // The nap-window guide (issue #46): a conclusion under the awake card,
  // only while it has something honest to say (see lib/nap-window.ts).
  const nap =
    napGuide && baby && s?.lastSleep?.endTime
      ? napWindow({
          birthDate: new Date(baby.birthDate),
          wakeAt: new Date(s.lastSleep.endTime),
        })
      : null;
  const openHelp = s?.openHelp ?? null;
  const tempStatus = temperatureStatus(
    s?.lastTemperature?.value ?? 0,
    tempTrend,
  );

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
        activeFeed={activeFeed}
        lastDiaper={s?.lastDiaper ?? null}
        openHelp={openHelp}
      />
    );
  }

  return (
    // Compact: one column, exactly as before. md: two panes — status on
    // the left, actions on the right edge, the edge the side panel opens
    // from, so the cards stay readable beside an open sheet ("left informs,
    // right acts", spec §4). xl: a third pane, Recent, in the middle.
    <div className="mx-auto max-w-md px-4 pt-safe md:grid md:max-w-none md:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] md:items-start md:gap-6 md:px-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_440px] xl:px-8">
      <div className="min-w-0">
        {/* Baby header */}
        <header className="flex items-center justify-between py-4">
          <BabySwitcher />
          <button
            type="button"
            aria-label={t("Account")}
            onClick={() => setSheet("account")}
            className={cn("rounded-full active:scale-95", focusRing)}
          >
            <Avatar
              src={me.data?.avatarUrl}
              name={me.data?.displayName ?? "?"}
              size={11}
            />
          </button>
        </header>

        <div className="space-y-3">
          {/* Below the baby header, above everything else: a call for help is
              the first thing to see, but it must not displace whose home this
              is. */}
          {openHelp && <HelpCard request={openHelp} />}
          {active && (
            <ActiveSleepBanner
              session={active}
              onEdit={(session) => {
                setEditSleep(session);
                setSheet("sleep-edit");
              }}
            />
          )}
          {activePlay && <ActivePlayBanner session={activePlay} />}
          {activeFeed && (
            <ActiveFeedBanner
              timer={activeFeed}
              onOpen={() => setSheet("feed")}
            />
          )}
          {activePump && (
            <ActivePumpBanner
              timer={activePump}
              onStop={() => {
                setOtherKind("pump");
                setPumpStop(true);
                setSheet("other");
              }}
            />
          )}
          {/* Status before action: last feed / last diaper at a glance */}
          <div className="grid grid-cols-1 gap-3">
            <StatusCard
              icon={IconBabyBottle}
              label={t("Last feed")}
              time={s?.lastFeed ? new Date(s.lastFeed.time) : null}
              detail={s?.lastFeed ? feedDetail(s.lastFeed, units) : undefined}
              sub={
                s
                  ? `${s.today.feeds} ${t("feeds")} · ${formatVolume(s.today.intakeMl, units)}${
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
                  ? `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}${s.today.dry > 0 ? ` · ${s.today.dry} ${t("dry")}` : ""}`
                  : undefined
              }
              tintClass="text-diaper"
              onClick={() => setSheet("diaper")}
            />
            {/* The wake window, not "last sleep N ago": the same instant read
                as a duration, because how long she has been up is what decides
                whether the next nap is due. The last sleep's length rides
                along as the detail. */}
            {!active && s?.lastSleep?.endTime && (
              <StatusCard
                icon={IconMoon}
                label={t("Awake")}
                time={new Date(s.lastSleep.endTime)}
                format={formatElapsed}
                detail={`${formatDuration(
                  new Date(s.lastSleep.endTime).getTime() -
                    new Date(s.lastSleep.startTime).getTime(),
                )} ${t("nap")}`}
                sub={`${s.today.sleeps} ${s.today.sleeps === 1 ? t("nap") : t("naps")} · ${formatDuration(s.today.sleepMin * 60_000)} ${t("today")}`}
                note={nap ? describeNapWindow(nap) : undefined}
                tintClass="text-sleep"
                onClick={() => setSheet("sleep")}
              />
            )}
            {/* Only while it is still a live question — see
                showsTemperatureCard. A fever takes the danger tint so it reads
                at a glance, which is the whole reason the card exists. */}
            {s?.lastTemperature &&
              showsTemperatureCard(new Date(s.lastTemperature.time)) && (
                <StatusCard
                  icon={IconTemperature}
                  label={t("Last temperature")}
                  time={new Date(s.lastTemperature.time)}
                  detail={`${formatMeasurementIn(
                    s.lastTemperature.type,
                    s.lastTemperature.value,
                    units,
                  )} ${TREND_ARROW[tempTrend]}`}
                  sub={
                    tempStatus === "ok" ? undefined : t(TREND_LABEL[tempTrend])
                  }
                  tintClass={STATUS_TINT[tempStatus]}
                  accessory={
                    <span className={STATUS_TINT[tempStatus]}>
                      <TemperatureSparkline rows={measurementRows} />
                    </span>
                  }
                  onClick={() => {
                    setOtherKind("measurement");
                    setMeasurementType("temperature");
                    setSheet("other");
                  }}
                />
              )}
          </div>
        </div>
      </div>

      {/* xl only: today's log beside the actions. */}
      <HomeRecent babyId={baby.id} />

      {/* Primaries (+ More on the phone; the unfolded tiles from md up).
          pb-tabbar clears the bottom bar on the phone and is 1.5rem from md
          (styles.css). */}
      <div className="pt-4 pb-tabbar md:sticky md:top-0 md:pt-6">
        <HomeActions
          active={!!active}
          onFeed={() => setSheet("feed")}
          onDiaper={() => setSheet("diaper")}
          onSleep={() => setSheet("sleep")}
          onMore={() => {
            prefetchOtherLists(queryClient, baby.id);
            setSheet("more");
          }}
          actions={actions}
        />
      </div>

      <FeedSheet
        open={sheet === "feed"}
        onOpenChange={(o) => setSheet(o ? "feed" : null)}
        babyId={baby.id}
        recentFeeds={feeds.data ?? []}
        activeFeed={activeFeed}
      />
      <DiaperSheet
        open={sheet === "diaper"}
        onOpenChange={(o) => setSheet(o ? "diaper" : null)}
        babyId={baby.id}
        lastDiaper={s?.lastDiaper ?? null}
      />
      <SleepSheet
        open={sheet === "sleep" || sheet === "sleep-edit"}
        onOpenChange={(o) => {
          if (!o) setSheet(null);
        }}
        babyId={baby.id}
        lastLocation={s?.lastSleep?.location ?? null}
        edit={sheet === "sleep-edit" ? editSleep : null}
      />
      <MoreSheet
        open={sheet === "more"}
        onOpenChange={(o) => setSheet(o ? "more" : null)}
        onPick={(kind) => {
          setOtherKind(kind);
          setPumpStop(false);
          // Reset: the temperature card sets this, and without clearing it
          // here the More picker would keep opening on temperature ever after.
          setMeasurementType("weight");
          setSheet("other");
        }}
        onPickPlay={(type) => {
          setPlayType(type);
          setSheet("play");
        }}
        onPickHelp={() => setSheet("help")}
      />
      <OtherLogSheet
        open={sheet === "other"}
        onOpenChange={(o) => setSheet(o ? "other" : null)}
        babyId={baby.id}
        kind={otherKind}
        initialMeasurementType={measurementType}
        activePump={activePump}
        stopTimer={pumpStop}
      />
      <PlaySheet
        open={sheet === "play"}
        onOpenChange={(o) => setSheet(o ? "play" : null)}
        babyId={baby.id}
        type={playType}
      />
      <HelpSheet
        open={sheet === "help"}
        onOpenChange={(o) => setSheet(o ? "help" : null)}
      />
      <AccountSheet
        open={sheet === "account"}
        onOpenChange={(o) => setSheet(o ? "account" : null)}
      />

      {/* Day-mode Home only: night mode is three actions and nothing else. */}
      <InstallBanner />
    </div>
  );
}

// Replaced by components/HomeRecent.tsx in the next task.
function HomeRecent(_props: { babyId: string }) {
  return null;
}

// Night mode home: three actions only, everything in the bottom half,
// nothing bright (CLAUDE.md §6).
function NightHome({
  babyId,
  sheet,
  setSheet,
  activeSleepId,
  recentFeeds,
  activeFeed,
  lastDiaper,
  openHelp,
}: {
  babyId: string;
  sheet: OpenSheet;
  setSheet: (s: OpenSheet) => void;
  activeSleepId: string | null;
  recentFeeds: Parameters<typeof FeedSheet>[0]["recentFeeds"];
  activeFeed: Parameters<typeof FeedSheet>[0]["activeFeed"];
  lastDiaper: Parameters<typeof DiaperSheet>[0]["lastDiaper"];
  openHelp: HelpRequest | null;
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
    // md and up: the same phone-width column, anchored bottom-right — "right
    // acts", and never three 1000 px buttons across a tablet (spec §4).
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-end px-4 pb-tabbar md:mr-0 md:ml-auto md:px-6">
      <div className="space-y-3 pb-4">
        <IconBabyCarriage className="mx-auto h-6 w-6 text-muted" />
        {openHelp && <HelpCard request={openHelp} />}
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
        activeFeed={activeFeed}
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
