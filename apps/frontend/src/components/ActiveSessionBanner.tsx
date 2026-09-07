import {
  IconBabyBottle,
  IconMilk,
  IconMoon,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { FeedTimer, PlayLog, SleepLog } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import {
  isOptimisticTimer,
  useStopFeedTimer,
  useStopPlay,
  useWakeSleep,
} from "@/lib/data";
import { clock, totalSeconds } from "@/lib/feed-timer-ui";
import { t } from "@/lib/i18n";
import { playKindMeta } from "@/lib/play-ui";
import { formatClock, formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

// Active sessions are state, not screens: these banners render wherever the
// summary says so, with a live counter and one tap to end. Sleep and play
// share the shape — only the icon, tint and verb differ.

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function SessionBanner({
  icon: Icon,
  tint,
  label,
  startTime,
  action,
  onAction,
  onOpen,
  openLabel,
  disabled,
  emphasis = "ring",
  elapsedMs,
  detail,
  tickMs = 30_000,
  format = formatDuration,
}: {
  icon: TablerIcon;
  tint: string;
  label: string;
  startTime: Date;
  action: string;
  onAction: () => void;
  // When given, the icon + counter become a tap target of their own, next
  // to (never around) the action button — nested buttons are invalid HTML
  // and read as one control to assistive tech.
  onOpen?: () => void;
  openLabel?: string;
  disabled: boolean;
  // How the card says "this is running". Play gets the accent ring (an
  // activity to come back to); sleep breathes in its own tint — the same
  // radiating ring as the help card, but slower and fainter, since it can
  // be on screen for hours (styles.css animate-sleep-breathe).
  emphasis?: "ring" | "breathe";
  // A timer that pauses (nursing) counts banked seconds, not wall time —
  // the default counter is now minus startTime.
  elapsedMs?: (now: number) => number;
  // Replaces "since HH:MM" when given ("Left", "Paused").
  detail?: string;
  tickMs?: number;
  // A nursing clock reads mm:ss; a nap reads "1:10".
  format?: (ms: number) => string;
}) {
  const now = useNow(tickMs);
  const body = (
    <>
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2",
          tint,
        )}
      >
        <Icon className="h-5 w-5 animate-pulse-soft" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {label}
        </p>
        <p className="text-base font-bold text-ink">
          {format(elapsedMs ? elapsedMs(now) : now - startTime.getTime())}
          <span className="ml-1.5 font-medium text-ink-soft">
            {detail ?? `${t("since")} ${formatClock(startTime)}`}
          </span>
        </p>
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl2 border bg-surface p-4",
        emphasis === "ring"
          ? "border-accent ring-1 ring-accent/40"
          : "border-sleep animate-sleep-breathe",
      )}
    >
      {onOpen ? (
        // Negative margin + matching padding: the hit area reaches the
        // card's edge, the visible layout does not move.
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="-m-4 mr-0 flex min-w-0 flex-1 items-center gap-3 rounded-l-xl2 p-4 text-left active:bg-surface-2"
        >
          {body}
        </button>
      ) : (
        body
      )}
      <Button variant="secondary" onClick={onAction} disabled={disabled}>
        {action}
      </Button>
    </div>
  );
}

// `onEdit` opens the same edit sheet a timeline tap does, for fixing a start
// time that was logged late. An optimistic (not yet persisted) session has
// no id to edit, so the tap target is withheld until the server answers.
export function ActiveSleepBanner({
  session,
  onEdit,
}: {
  session: SleepLog;
  onEdit?: (session: SleepLog) => void;
}) {
  const wakeSleep = useWakeSleep();
  const editable = !!onEdit && session.id !== "optimistic";
  return (
    <SessionBanner
      icon={IconMoon}
      tint="text-sleep"
      label={t("Sleeping")}
      startTime={new Date(session.startTime)}
      action={t("Wake")}
      onAction={() => wakeSleep.mutate({ id: session.id })}
      onOpen={editable ? () => onEdit(session) : undefined}
      openLabel={t("Edit sleep")}
      disabled={wakeSleep.isPending || session.id === "optimistic"}
      emphasis="breathe"
    />
  );
}

// The shared nursing timer (issue #44): Stop logs the feed from the
// server's clock in one tap; the body opens the feed sheet to adjust the
// minutes or add a note first. Banked seconds, not wall time, so a paused
// timer stands still.
export function ActiveFeedBanner({
  timer,
  onOpen,
}: {
  timer: FeedTimer;
  onOpen?: () => void;
}) {
  const stop = useStopFeedTimer();
  const busy = stop.isPending || isOptimisticTimer(timer);
  const side =
    timer.runningSide === "left"
      ? t("Left")
      : timer.runningSide === "right"
        ? t("Right")
        : t("Paused");
  return (
    <SessionBanner
      icon={IconBabyBottle}
      tint="text-feed"
      label={t("Feeding")}
      startTime={new Date(timer.startTime)}
      elapsedMs={(now) => totalSeconds(timer, now) * 1000}
      format={(ms) => clock(Math.floor(ms / 1000))}
      detail={side}
      tickMs={1000}
      action={t("Stop")}
      onAction={() =>
        stop.mutate({ id: timer.id, babyId: timer.babyId, kind: "breast" })
      }
      onOpen={busy ? undefined : onOpen}
      openLabel={t("Feed")}
      disabled={busy}
      emphasis="ring"
    />
  );
}

// A pump timer is one clock; Stop opens the pump sheet, because the amount
// is the one thing the clock cannot know.
export function ActivePumpBanner({
  timer,
  onStop,
}: {
  timer: FeedTimer;
  onStop: () => void;
}) {
  return (
    <SessionBanner
      icon={IconMilk}
      tint="text-feed"
      label={t("Pumping")}
      startTime={new Date(timer.startTime)}
      elapsedMs={(now) => totalSeconds(timer, now) * 1000}
      format={(ms) => clock(Math.floor(ms / 1000))}
      tickMs={1000}
      action={t("Stop")}
      onAction={onStop}
      disabled={isOptimisticTimer(timer)}
      emphasis="ring"
    />
  );
}

export function ActivePlayBanner({ session }: { session: PlayLog }) {
  const stopPlay = useStopPlay();
  const meta = playKindMeta[session.type];
  return (
    <SessionBanner
      icon={meta.icon}
      tint={meta.tint}
      label={t(meta.label)}
      startTime={new Date(session.startTime)}
      action={t("Stop")}
      onAction={() => stopPlay.mutate({ id: session.id })}
      disabled={stopPlay.isPending || session.id === "optimistic"}
      emphasis="ring"
    />
  );
}
