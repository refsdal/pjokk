import { IconMoon, type Icon as TablerIcon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { PlayLog, SleepLog } from "@shared/schemas";
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
  disabled,
  emphasis = false,
}: {
  icon: TablerIcon;
  tint: string;
  label: string;
  startTime: Date;
  action: string;
  onAction: () => void;
  disabled: boolean;
  emphasis?: boolean;
}) {
  const now = useNow();
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl2 border bg-surface p-4",
        // A running activity is the only thing on this screen the caretaker
        // has to come back to, so it gets the ring; sleep keeps the hairline.
        emphasis ? "border-accent ring-1 ring-accent/40" : "border-line",
      )}
    >
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
      <Button variant="secondary" onClick={onAction} disabled={disabled}>
        {action}
      </Button>
    </div>
  );
}

export function ActiveSleepBanner({ session }: { session: SleepLog }) {
  const wakeSleep = useWakeSleep();
  return (
    <SessionBanner
      icon={IconMoon}
      tint="text-sleep"
      label={t("Sleeping")}
      startTime={new Date(session.startTime)}
      action={t("Wake")}
      onAction={() => wakeSleep.mutate({ id: session.id })}
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
