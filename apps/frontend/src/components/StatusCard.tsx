import type { ReactNode } from "react";
import type { Icon as TablerIcon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

// Status before action (CLAUDE.md §1): relative time, zero taps. Category
// color goes on the icon only, never the background.
export function StatusCard({
  icon: Icon,
  label,
  time,
  format = formatRelative,
  detail,
  sub,
  note,
  tintClass,
  onClick,
  accessory,
}: {
  icon: TablerIcon;
  label: string;
  time: Date | null;
  // How `time` reads. "N ago" by default; the awake card passes
  // formatElapsed for a duration. A function rather than a ready-made
  // string so the minute tick below recomputes it — a string computed in
  // the parent's render would sit stale until the parent re-rendered.
  format?: (time: Date) => string;
  detail?: string;
  sub?: string;
  // A second small line under `sub`, for a conclusion rather than a count
  // (the awake card's nap window). Ink-soft, not the category tint: a
  // guide line must not read as an alarm.
  note?: string;
  tintClass: string;
  onClick?: () => void;
  // Optional trailing slot, pushed to the right edge. The temperature card
  // puts its three-day sparkline here; nothing else uses it yet.
  accessory?: ReactNode;
}) {
  // Re-render each minute so "5 m ago" stays honest.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl2 border border-line bg-surface p-4 text-left active:bg-surface-2",
        focusRing,
      )}
    >
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2",
          tintClass,
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {label}
        </p>
        <p className="truncate text-base font-bold text-ink">
          {time ? format(time) : "—"}
          {detail ? (
            <span className="ml-1.5 font-medium text-ink-soft">{detail}</span>
          ) : null}
        </p>
        {sub ? <p className="truncate text-xs text-muted">{sub}</p> : null}
        {note ? (
          <p className="truncate text-xs font-medium text-ink-soft">{note}</p>
        ) : null}
      </div>
      {accessory ? (
        <div className="ml-auto shrink-0 pl-2">{accessory}</div>
      ) : null}
    </button>
  );
}
