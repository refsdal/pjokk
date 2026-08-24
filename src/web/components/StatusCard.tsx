import type { Icon as TablerIcon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

// Status before action (CLAUDE.md §1): relative time, zero taps. Category
// color goes on the icon only, never the background.
export function StatusCard({
  icon: Icon,
  label,
  time,
  detail,
  tintClass,
  onClick,
}: {
  icon: TablerIcon;
  label: string;
  time: Date | null;
  detail?: string;
  tintClass: string;
  onClick?: () => void;
}) {
  // Re-render each minute so "5 m ago" stays honest.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card
      className="flex items-center gap-3 active:bg-surface-2"
      onClick={onClick}
      role={onClick ? "button" : undefined}
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
          {time ? formatRelative(time) : "—"}
          {detail ? (
            <span className="ml-1.5 font-medium text-ink-soft">{detail}</span>
          ) : null}
        </p>
      </div>
    </Card>
  );
}
