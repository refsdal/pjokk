import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { IconBabyBottle, IconDiaper, IconMoon } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { KioskAction } from "@/components/kiosk/KioskAction";
import { KioskBand } from "@/components/kiosk/KioskBand";
import { KioskCard } from "@/components/kiosk/KioskCard";
import { KioskIdleOverlay } from "@/components/kiosk/KioskIdleOverlay";
import { KioskMedicineStrip } from "@/components/kiosk/KioskMedicineStrip";
import { KioskPinPad } from "@/components/kiosk/KioskPinPad";
import { KioskUndo, UNDO_MS } from "@/components/kiosk/KioskUndo";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { useAppearance } from "@/lib/appearance";
import {
  useCreateOther,
  useDeleteDiaper,
  useDeleteFeed,
  useDeleteOther,
  useDeleteSleep,
  useFeeds,
  useLogDiaper,
  useLogFeed,
  useMedicineCatalogue,
  useReminders,
  useSetFeedTimerSide,
  useSleepLocations,
  useStartFeedTimer,
  useStartSleep,
  useStopFeedTimer,
  useSummary,
  useWakeSleep,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { disableKiosk, storedPinLength } from "@/lib/kiosk";
import { useIdle, useWakeLock } from "@/lib/kiosk-screen";
import {
  cautionFor,
  elapsedShort,
  feedCardView,
  lastBottle,
  PIN_LOCKOUT_MS,
  sleepCardView,
  totalsLines,
  type UndoKind,
  undoText,
} from "@/lib/kiosk-ui";
import { describeNapWindow, napWindow, useNapGuide } from "@/lib/nap-window";
import { sleepTypeAt } from "@/lib/night";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatVolume, useUnits } from "@/lib/units";
import { AuthGate } from "@/screens/shell";

// The care station (spec: kiosk mode). Everything here already exists in
// the API: the screen is Home's data with one-tap actions on the cards and
// an Undo instead of a sheet.
export function KioskRoute() {
  return (
    <AuthGate>
      <KioskScreen />
    </AuthGate>
  );
}

type Undo = { kind: UndoKind; id: string; text: string };

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function KioskScreen() {
  const navigate = useNavigate();
  const { babies, baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  const locations = useSleepLocations();
  const reminders = useReminders();
  const catalogue = useMedicineCatalogue(baby?.id, !!baby);
  const units = useUnits();
  const { night } = useAppearance();
  const napGuide = useNapGuide();
  // A second tick while a nursing timer runs, half a minute otherwise.
  const now = useNow(summary.data?.activeFeed ? 1000 : 30_000);

  useWakeLock();
  const [idle, wake] = useIdle();

  const logFeed = useLogFeed();
  const logDiaper = useLogDiaper();
  const startSleep = useStartSleep();
  const wakeSleep = useWakeSleep();
  const startTimer = useStartFeedTimer();
  const switchSide = useSetFeedTimerSide();
  const stopTimer = useStopFeedTimer();
  const createOther = useCreateOther();
  const delFeed = useDeleteFeed();
  const delDiaper = useDeleteDiaper();
  const delSleep = useDeleteSleep();
  const delOther = useDeleteOther();

  const [undo, setUndo] = useState<Undo | null>(null);
  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [undo]);
  const doUndo = () => {
    if (!undo) return;
    if (undo.kind === "feed") delFeed.mutate({ id: undo.id });
    if (undo.kind === "diaper") delDiaper.mutate({ id: undo.id });
    if (undo.kind === "sleep") delSleep.mutate({ id: undo.id });
    if (undo.kind === "medicine")
      delOther.mutate({ kind: "medicine", id: undo.id });
    setUndo(null);
  };

  const [pad, setPad] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const leave = useCallback(() => {
    disableKiosk();
    void navigate({ to: "/home" });
  }, [navigate]);
  const lockout = useCallback(() => {
    setPad(false);
    setLockedUntil(Date.now() + PIN_LOCKOUT_MS);
  }, []);
  const closePad = useCallback(() => setPad(false), []);
  const pinPad = pad && (
    <KioskPinPad
      length={storedPinLength() ?? 4}
      onSuccess={leave}
      onCancel={closePad}
      onLockout={lockout}
    />
  );

  if (babies.isError) {
    return (
      <div className="flex min-h-dvh flex-col justify-center bg-bg">
        <ErrorState onRetry={() => void babies.refetch()} />
      </div>
    );
  }
  if (!baby) {
    if (babies.isSuccess) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-8 text-center text-ink">
          <p className="text-lg font-bold">{t("No baby yet")}</p>
          <Button variant="outline" onClick={() => setPad(true)}>
            {t("Leave kiosk mode")}
          </Button>
          {pinPad}
        </div>
      );
    }
    return (
      <div className="flex min-h-dvh flex-col justify-center bg-bg">
        <LoadingState />
      </div>
    );
  }

  const s = summary.data;
  const babyId = baby.id;
  const iso = () => new Date().toISOString();
  const rem = reminders.data ?? [];
  const sleepView = sleepCardView(
    { activeSleep: s?.activeSleep ?? null, lastSleep: s?.lastSleep ?? null },
    now,
  );
  const feedView = feedCardView(
    { lastFeed: s?.lastFeed ?? null, activeFeed: s?.activeFeed ?? null },
    units,
    now,
  );
  const bottle = lastBottle(feeds.data ?? []);
  const bottleLabel = formatVolume(bottle.amountMl, units);
  const feedCaution =
    !feedView.live &&
    cautionFor(
      "feed",
      s?.lastFeed ? new Date(s.lastFeed.time) : null,
      rem,
      babyId,
      now,
    );
  const diaperCaution = cautionFor(
    "diaper",
    s?.lastDiaper ? new Date(s.lastDiaper.time) : null,
    rem,
    babyId,
    now,
  );
  const nap =
    napGuide && s?.lastSleep?.endTime && !s.activeSleep
      ? napWindow({
          birthDate: new Date(baby.birthDate),
          wakeAt: new Date(s.lastSleep.endTime),
          now,
        })
      : null;
  const lastLocation =
    s?.lastSleep?.location ?? s?.activeSleep?.location ?? null;
  const otherLocations = (locations.data ?? [])
    .map((l) => l.name)
    .filter((n) => n !== lastLocation)
    .slice(0, 2);
  const medicines: MedicineCatalogueEntry[] = (catalogue.data ?? []).filter(
    (m) => !m.archived,
  );
  const activeSleep = s?.activeSleep ?? null;
  const activeFeed = s?.activeFeed ?? null;

  const startSleepAt = (location: string | null) =>
    startSleep.mutate(
      {
        babyId,
        startTime: iso(),
        location: location ?? undefined,
        type: sleepTypeAt(new Date()),
      },
      {
        onSuccess: (row) =>
          setUndo({ kind: "sleep", id: row.id, text: undoText("sleep") }),
      },
    );

  return (
    <div className="min-h-dvh bg-bg px-6 pt-safe pb-safe text-ink md:px-8">
      <KioskBand
        baby={baby}
        now={now}
        totals={night || !s ? null : totalsLines(s.today, units)}
        onHold={() => setPad(true)}
        holdDisabled={Date.now() < lockedUntil}
      />
      {!night && nap && (
        <p
          className="pt-2.5 text-center text-lg font-semibold text-accent"
          data-testid="kiosk-nap"
        >
          {describeNapWindow(nap)}
        </p>
      )}

      <div className="grid gap-3.5 pt-5 md:grid-cols-3">
        <KioskCard
          testId="kiosk-sleep"
          icon={IconMoon}
          tint="text-sleep"
          label={sleepView.state === "sleeping" ? t("Sleeping") : t("Awake")}
          headline={sleepView.headline}
          detail={sleepView.detail}
          sub={
            night || !s
              ? null
              : `${s.today.sleeps} ${s.today.sleeps === 1 ? t("nap") : t("naps")} ${t("today")}`
          }
          tone={sleepView.state === "sleeping" ? "live" : "normal"}
        >
          {activeSleep ? (
            <KioskAction
              label={t("Wake")}
              primary
              onClick={() =>
                wakeSleep.mutate({ id: activeSleep.id, endTime: iso() })
              }
            />
          ) : (
            <>
              <KioskAction
                label={t("Sleep")}
                hint={lastLocation ?? undefined}
                primary
                onClick={() => startSleepAt(lastLocation)}
              />
              {otherLocations.map((name) => (
                <KioskAction
                  key={name}
                  label={name}
                  onClick={() => startSleepAt(name)}
                />
              ))}
            </>
          )}
        </KioskCard>

        <KioskCard
          testId="kiosk-feed"
          icon={IconBabyBottle}
          tint="text-feed"
          label={t("Feed")}
          headline={feedView.headline}
          detail={feedView.detail}
          sub={
            night || !s
              ? null
              : `${s.today.feeds} ${t("feeds")} · ${formatVolume(s.today.intakeMl, units)} ${t("today")}`
          }
          tone={feedView.live ? "live" : feedCaution ? "caution" : "normal"}
        >
          {activeFeed ? (
            <>
              <KioskAction
                label={t("Switch")}
                onClick={() =>
                  switchSide.mutate({
                    id: activeFeed.id,
                    babyId,
                    side: activeFeed.runningSide === "left" ? "right" : "left",
                  })
                }
              />
              <KioskAction
                label={t("Stop")}
                primary
                onClick={() =>
                  stopTimer.mutate({
                    id: activeFeed.id,
                    babyId,
                    kind: "breast",
                    time: iso(),
                  })
                }
              />
            </>
          ) : (
            <>
              <KioskAction
                label={t("Bottle")}
                hint={bottleLabel}
                primary
                onClick={() =>
                  logFeed.mutate(
                    {
                      babyId,
                      time: iso(),
                      type: "bottle",
                      amountMl: bottle.amountMl,
                      contents: bottle.contents ?? undefined,
                    },
                    {
                      onSuccess: (row) =>
                        setUndo({
                          kind: "feed",
                          id: row.id,
                          text: undoText("feed", bottleLabel),
                        }),
                    },
                  )
                }
              />
              <KioskAction
                label={t("Breast L")}
                onClick={() =>
                  startTimer.mutate({
                    babyId,
                    kind: "breast",
                    side: "left",
                    startTime: iso(),
                  })
                }
              />
              <KioskAction
                label={t("Breast R")}
                onClick={() =>
                  startTimer.mutate({
                    babyId,
                    kind: "breast",
                    side: "right",
                    startTime: iso(),
                  })
                }
              />
            </>
          )}
        </KioskCard>

        <KioskCard
          testId="kiosk-diaper"
          icon={IconDiaper}
          tint="text-diaper"
          label={t("Diaper")}
          headline={
            s?.lastDiaper ? elapsedShort(new Date(s.lastDiaper.time), now) : "—"
          }
          detail={
            s?.lastDiaper
              ? `${t("ago")} · ${t(s.lastDiaper.type)}`
              : t("No diaper logged yet")
          }
          sub={
            night || !s
              ? null
              : `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}`
          }
          tone={diaperCaution ? "caution" : "normal"}
        >
          {(["wet", "dirty", "both"] as const).map((type) => (
            <KioskAction
              key={type}
              label={t(
                type === "wet" ? "Wet" : type === "dirty" ? "Dirty" : "Both",
              )}
              onClick={() =>
                logDiaper.mutate(
                  { babyId, time: iso(), type },
                  {
                    onSuccess: (row) =>
                      setUndo({
                        kind: "diaper",
                        id: row.id,
                        text: undoText("diaper", type),
                      }),
                  },
                )
              }
            />
          ))}
        </KioskCard>
      </div>

      {!night && medicines.length > 0 && (
        <div className="space-y-3 pt-3.5">
          {medicines.map((m) => (
            <KioskMedicineStrip
              key={m.id}
              entry={m}
              now={now}
              onLog={() =>
                createOther.mutate(
                  {
                    kind: "medicine",
                    babyId,
                    time: iso(),
                    medicineId: m.id,
                    name: m.name,
                    amount: m.defaultAmount ?? undefined,
                    unit: m.unit ?? undefined,
                  },
                  {
                    onSuccess: (row) => {
                      const id = (row as { id?: string } | null)?.id;
                      if (id)
                        setUndo({
                          kind: "medicine",
                          id,
                          text: undoText("medicine", m.name),
                        });
                    },
                  },
                )
              }
            />
          ))}
        </div>
      )}

      <p className="fixed right-8 bottom-4 text-[13px] text-muted">
        {t("Hold the name to leave kiosk")}
      </p>
      {undo && <KioskUndo text={undo.text} onUndo={doUndo} />}
      <KioskIdleOverlay state={idle} onWake={wake} />
      {pinPad}
    </div>
  );
}
