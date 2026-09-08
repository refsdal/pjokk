import type { Baby } from "@pjokk/shared";
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { formatAge, formatClock, formatDay } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

export const HOLD_MS = 1500;

// The top band (spec §4): name + date left (the name is the press-and-hold
// target for leaving), the clock in the middle, today's totals right.
export function KioskBand({
  baby,
  now,
  totals,
  onHold,
  holdDisabled = false,
}: {
  baby: Baby;
  now: Date;
  totals: [string, string] | null;
  onHold: () => void;
  holdDisabled?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const stop = () => {
    setHolding(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    if (holdDisabled) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onHold();
    }, HOLD_MS);
  };
  useEffect(() => stop, []);
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 pt-5">
      <div className="min-w-0">
        <button
          type="button"
          aria-label={t("Hold to leave kiosk mode")}
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            "block max-w-full truncate rounded-xl text-left text-[26px] leading-8 font-extrabold text-ink select-none",
            holding && "opacity-60",
            focusRing,
          )}
        >
          {baby.name}
        </button>
        <p className="truncate text-sm font-semibold tracking-[.12em] text-muted uppercase">
          {formatDay(now)} · {formatAge(new Date(baby.birthDate))}
        </p>
      </div>
      <time
        className="text-7xl leading-none font-light tracking-tight tabular-nums text-ink"
        data-testid="kiosk-clock"
      >
        {formatClock(now)}
      </time>
      <div className="min-w-0 text-right text-[15px] leading-5 text-ink-soft">
        {totals && (
          <>
            <p className="truncate">{totals[0]}</p>
            <p className="truncate">{totals[1]}</p>
          </>
        )}
      </div>
    </header>
  );
}
