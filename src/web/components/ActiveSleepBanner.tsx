import { IconMoon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { SleepLog } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { useWakeSleep } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatClock, formatDuration } from "@/lib/time";
import { toast } from "@/lib/toast";

// Active sessions are state, not screens: this banner renders wherever the
// activeSession query says so, with a live counter and a one-tap Wake.
export function ActiveSleepBanner({ session }: { session: SleepLog }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const start = new Date(session.startTime);
  const wakeSleep = useWakeSleep();

  return (
    <div className="flex items-center gap-3 rounded-xl2 border border-line bg-surface p-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sleep">
        <IconMoon className="h-5 w-5 animate-pulse-soft" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Sleeping")}
        </p>
        <p className="text-base font-bold text-ink">
          {formatDuration(now - start.getTime())}
          <span className="ml-1.5 font-medium text-ink-soft">
            {t("since")} {formatClock(start)}
          </span>
        </p>
      </div>
      <Button
        variant="secondary"
        onClick={() => wakeSleep.mutate({ id: session.id })}
        disabled={wakeSleep.isPending || session.id === "optimistic"}
      >
        {t("Wake")}
      </Button>
    </div>
  );
}
