import { useMemo } from "react";
import { closedNotices } from "@/lib/calendar-ui";
import { useCalendarEvents } from "@/lib/data";
import { daycareMeta } from "@/lib/daycare-ui";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// "Daycare closed tomorrow" (issue #110): a closed barnehage day discovered
// at the gate is the failure this exists to prevent, so Home says it with
// zero taps the evening before and on the day. One quiet hairline row — a
// fact about tomorrow, not an alarm. It reads the ordinary calendar list
// for the two local days; nothing new on the server's summary.
export function ClosedDayLine() {
  // Midnight-to-midnight bounds, stable for the day so the query key is.
  const dayStamp = new Date().toDateString();
  const [from, to] = useMemo(() => {
    const start = new Date(dayStamp);
    const end = new Date(start);
    end.setDate(start.getDate() + 2);
    return [start, end];
  }, [dayStamp]);
  const events = useCalendarEvents(from, to);
  const notices = closedNotices(events.data ?? []);
  if (notices.length === 0) return null;
  const Icon = daycareMeta.icon;
  return (
    <div className="space-y-2" data-testid="closed-day">
      {notices.map((n) => (
        <div
          key={n.id}
          className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-4 py-3"
        >
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2",
              daycareMeta.tint,
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <p className="min-w-0 text-sm text-ink">
            <span className="font-bold">
              {n.when === "today"
                ? t("Daycare is closed today")
                : t("Daycare is closed tomorrow")}
            </span>
            <span className="text-ink-soft"> · {n.title}</span>
          </p>
        </div>
      ))}
    </div>
  );
}
