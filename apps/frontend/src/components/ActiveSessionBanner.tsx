import { IconMoon, type Icon as TablerIcon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { PlayLog, SleepLog } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { useStopPlay, useWakeSleep } from "@/lib/data";
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
  emphasis = false,
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
  emphasis?: boolean;
}) {
  const now = useNow();
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
          {formatDuration(now - startTime.getTime())}
          <span className="ml-1.5 font-medium text-ink-soft">
            {t("since")} {formatClock(startTime)}
          </span>
        </p>
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl2 border bg-surface p-4",
        // A running activity is the only thing on this screen the caretaker
        // has to come back to, so it gets the ring; sleep keeps the hairline.
        emphasis ? "border-accent ring-1 ring-accent/40" : "border-line",
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
      emphasis
    />
  );
}
