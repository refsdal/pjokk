import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { IconBabyBottle, IconDiaper, IconMoon } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { KioskAction } from "@/components/kiosk/KioskAction";
import { KioskBand } from "@/components/kiosk/KioskBand";
import { KioskCard } from "@/components/kiosk/KioskCard";
import {
  KioskCaretakers,
  KioskWhoPrompt,
} from "@/components/kiosk/KioskCaretakers";
import { KioskIdleOverlay } from "@/components/kiosk/KioskIdleOverlay";
import { KioskMedicineStrip } from "@/components/kiosk/KioskMedicineStrip";
import { KioskPinPad } from "@/components/kiosk/KioskPinPad";
import { KioskUndo, UNDO_MS } from "@/components/kiosk/KioskUndo";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useAppearance } from "@/lib/appearance";
import {
  unenrolDevice,
  useCreateOther,
  useDeleteDiaper,
  useDeleteFeed,
  useDeleteOther,
  useDeleteSleep,
  useDeviceMembers,
  useDeviceThresholds,
  useFeeds,
  useLogDiaper,
  useLogFeed,
  useMedicineCatalogue,
  useResumeSleep,
  useSetFeedTimerSide,
  useSleepLocations,
  useStartFeedTimer,
  useStartSleep,
  useStopFeedTimer,
  useSummary,
  useWakeSleep,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { leaveKiosk, storedPinLength } from "@/lib/kiosk";
import { useIdle, useWakeLock } from "@/lib/kiosk-screen";
import {
  caretakerAfterIdle,
  cautionFor,
  durationShort,
  elapsedShort,
  feedCardView,
  lastBottle,
  PIN_LOCKOUT_MS,
  sleepCardView,
  thresholdsToReminders,
  totalsLines,
  type UndoKind,
  undoText,
} from "@/lib/kiosk-ui";
import { describeNapWindow, napWindow, useNapGuide } from "@/lib/nap-window";
import { useResumableSleep } from "@/lib/sleep-resume";
import { napsLine } from "@/lib/sleep-ui";
import { sleepTypeAt } from "@/lib/night";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatVolume, type Units } from "@/lib/units";
import { DeviceGate } from "@/screens/kiosk/DeviceGate";

// The care station (spec: kiosk mode), run by an enrolled family device
// (spec 2026-09-10-kiosk-devices): the screen is Home's data with one-tap
// actions on the cards and an Undo instead of a sheet, and every write
// names who is logging.
export function KioskRoute() {
  return (
    <DeviceGate>
      <KioskScreen />
    </DeviceGate>
  );
}

// The Undo remembers who logged the entry: the delete is a write too, and
// is credited to the same person.
type Undo = { kind: UndoKind; id: string; text: string; caretakerId: string };

// A device is not a person, so it has no display-unit preference (users.units
// is per person, on /api/me, which a device cannot read). The kiosk shows the
// stored unit — a known v1 limitation (spec §6).
const KIOSK_UNITS: Units = "metric";

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function KioskScreen() {
  const { babies, baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  const locations = useSleepLocations();
  const thresholds = useDeviceThresholds();
  const members = useDeviceMembers();
  const catalogue = useMedicineCatalogue(baby?.id, !!baby);
  const units = KIOSK_UNITS;
  const { night } = useAppearance();
  const napGuide = useNapGuide();
  // A second tick while a nursing timer runs, half a minute otherwise.
  const now = useNow(summary.data?.activeFeed ? 1000 : 30_000);
  // Resume, for a Wake tapped too soon (lib/sleep-resume.ts).
  const resumable = useResumableSleep(summary.data);

  useWakeLock();
  const [idle, wake] = useIdle();

  // Who is logging (spec 2026-09-10 §6): chosen on the row, forgotten when
  // the kiosk dims. An action with nobody chosen waits in `pending` until
  // the prompt names someone, then runs as them.
  const [caretaker, setCaretaker] = useState<string | null>(null);
  const [pending, setPending] = useState<((id: string) => void) | null>(null);
  useEffect(() => {
    setCaretaker((current) => caretakerAfterIdle(idle, current));
    if (idle === "dim") setPending(null);
  }, [idle]);
  const act = (run: (caretakerId: string) => void) => {
    if (caretaker) run(caretaker);
    else setPending(() => run);
  };
  const choose = (userId: string) => {
    setCaretaker(userId);
    const run = pending;
    setPending(null);
    run?.(userId);
  };
  // Someone removed from the family since the row loaded: the server says
  // NOT_MEMBER. Forget the choice and reload the faces; the mutation's own
  // toast says why the entry did not save.
  const refetchMembers = members.refetch;
  const onWriteError = useCallback(
    (err: Error) => {
      if (err instanceof ApiError && err.code === "NOT_MEMBER") {
        setCaretaker(null);
        void refetchMembers();
      }
    },
    [refetchMembers],
  );

  const logFeed = useLogFeed();
  const logDiaper = useLogDiaper();
  const startSleep = useStartSleep();
  const wakeSleep = useWakeSleep();
  const resumeSleep = useResumeSleep();
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
    const { kind, id, caretakerId } = undo;
    const options = { onError: onWriteError };
    if (kind === "feed") delFeed.mutate({ id, caretakerId }, options);
    if (kind === "diaper") delDiaper.mutate({ id, caretakerId }, options);
    if (kind === "sleep") delSleep.mutate({ id, caretakerId }, options);
    if (kind === "medicine")
      delOther.mutate({ kind: "medicine", id, caretakerId }, options);
    setUndo(null);
  };

  const [pad, setPad] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  // The server has un-enrolled the device (the pad's verify): forget
  // everything and go to sign-in — a full load, so no family data survives
  // in memory either.
  const leave = useCallback(() => {
    void leaveKiosk().then(() => window.location.assign("/login"));
  }, []);
  const lockout = useCallback(() => {
    setPad(false);
    setLockedUntil(Date.now() + PIN_LOCKOUT_MS);
  }, []);
  const closePad = useCallback(() => setPad(false), []);
  const pinPad = pad && (
    <KioskPinPad
      length={storedPinLength() ?? 4}
      verify={unenrolDevice}
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
  const rem = thresholdsToReminders(thresholds.data ?? []);
  const faces = members.data ?? [];
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
    // One fewer while Resume takes a slot, so the row still fits the card.
    .slice(0, resumable ? 1 : 2);
  const medicines: MedicineCatalogueEntry[] = (catalogue.data ?? []).filter(
    (m) => !m.archived,
  );
  const activeSleep = s?.activeSleep ?? null;
  const activeFeed = s?.activeFeed ?? null;

  const startSleepAt = (location: string | null, caretakerId: string) =>
    startSleep.mutate(
      {
        caretakerId,
        babyId,
        startTime: iso(),
        location: location ?? undefined,
        type: sleepTypeAt(new Date()),
      },
      {
        onSuccess: (row) =>
          setUndo({
            kind: "sleep",
            id: row.id,
            text: undoText("sleep"),
            caretakerId,
          }),
        onError: onWriteError,
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
      <KioskCaretakers
        members={faces}
        selected={caretaker}
        onSelect={setCaretaker}
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
              : napsLine(
                  s.today,
                  s.lastNightMin,
                  (min) => durationShort(min * 60_000),
                  s.lastNightLongestMin ?? null,
                )
          }
          tone={sleepView.state === "sleeping" ? "live" : "normal"}
        >
          {activeSleep ? (
            <KioskAction
              label={t("Wake")}
              primary
              onClick={() =>
                act((caretakerId) =>
                  wakeSleep.mutate(
                    { id: activeSleep.id, endTime: iso(), caretakerId },
                    { onError: onWriteError },
                  ),
                )
              }
            />
          ) : (
            <>
              {resumable && (
                <KioskAction
                  label={t("Resume")}
                  onClick={() =>
                    act((caretakerId) =>
                      resumeSleep.mutate(
                        { id: resumable.id, babyId, caretakerId },
                        { onError: onWriteError },
                      ),
                    )
                  }
                />
              )}
              <KioskAction
                label={t("Sleep")}
                hint={lastLocation ?? undefined}
                primary
                onClick={() => act((c) => startSleepAt(lastLocation, c))}
              />
              {otherLocations.map((name) => (
                <KioskAction
                  key={name}
                  label={name}
                  onClick={() => act((c) => startSleepAt(name, c))}
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
                  act((caretakerId) =>
                    switchSide.mutate(
                      {
                        caretakerId,
                        id: activeFeed.id,
                        babyId,
                        side:
                          activeFeed.runningSide === "left" ? "right" : "left",
                      },
                      { onError: onWriteError },
                    ),
                  )
                }
              />
              <KioskAction
                label={t("Stop")}
                primary
                onClick={() =>
                  act((caretakerId) =>
                    stopTimer.mutate(
                      {
                        caretakerId,
                        id: activeFeed.id,
                        babyId,
                        kind: "breast",
                        time: iso(),
                      },
                      { onError: onWriteError },
                    ),
                  )
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
                  act((caretakerId) =>
                    logFeed.mutate(
                      {
                        caretakerId,
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
                            caretakerId,
                          }),
                        onError: onWriteError,
                      },
                    ),
                  )
                }
              />
              {(["left", "right"] as const).map((side) => (
                <KioskAction
                  key={side}
                  label={side === "left" ? t("Breast L") : t("Breast R")}
                  onClick={() =>
                    act((caretakerId) =>
                      startTimer.mutate(
                        {
                          caretakerId,
                          babyId,
                          kind: "breast",
                          side,
                          startTime: iso(),
                        },
                        { onError: onWriteError },
                      ),
                    )
                  }
                />
              ))}
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
                act((caretakerId) =>
                  logDiaper.mutate(
                    { caretakerId, babyId, time: iso(), type },
                    {
                      onSuccess: (row) =>
                        setUndo({
                          kind: "diaper",
                          id: row.id,
                          text: undoText("diaper", type),
                          caretakerId,
                        }),
                      onError: onWriteError,
                    },
                  ),
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
                act((caretakerId) =>
                  createOther.mutate(
                    {
                      caretakerId,
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
                            caretakerId,
                          });
                      },
                      onError: onWriteError,
                    },
                  ),
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
      {pending && (
        <KioskWhoPrompt
          members={faces}
          onSelect={choose}
          onCancel={() => setPending(null)}
        />
      )}
      <KioskIdleOverlay state={idle} onWake={wake} />
      {pinPad}
    </div>
  );
}
