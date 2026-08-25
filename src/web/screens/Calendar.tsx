import { useMemo, useState } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconLock,
  IconPlus,
} from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CalendarEvent } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { ErrorState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EventSheet } from "@/components/sheets/EventSheet";
import { useCalendarEvents, usePremium } from "@/lib/data";
import {
  calendarCategoryMeta,
  dayKey,
  monthGridDays,
  weekStart,
} from "@/lib/calendar-ui";
import { t } from "@/lib/i18n";
import { formatClock, formatDay } from "@/lib/time";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const monthFmt = new Intl.DateTimeFormat("nb-NO", {
  month: "long",
  year: "numeric",
});
const weekdayFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "short" });

function dayLabel(d: Date): string {
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t("Today");
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return t("Tomorrow");
  return formatDay(d);
}

function eventTimeLine(e: CalendarEvent): string {
  if (e.allDay) return t("All day");
  const start = new Date(e.startTime);
  if (!e.durationMin) return formatClock(start);
  const end = new Date(start.getTime() + e.durationMin * 60_000);
  return `${formatClock(start)}–${formatClock(end)}`;
}

function EventRow({
  event,
  onTap,
}: {
  event: CalendarEvent;
  onTap: (e: CalendarEvent) => void;
}) {
  const meta = calendarCategoryMeta[event.category];
  const Icon = meta.icon;
  const people = event.assignees.map((a) => a.name).join(", ");
  return (
    <button
      type="button"
      onClick={() => onTap(event)}
      className="flex min-h-11 w-full items-center gap-3 border-b border-line py-2 text-left last:border-b-0 active:bg-surface-2"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2"
        style={{ color: meta.colorVar }}
      >
        <Icon className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">
          {event.title}
          {event.babies.length > 0 && (
            <span className="ml-1.5 font-medium text-muted">
              · {event.babies.map((b) => b.name).join(", ")}
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-muted">
          {eventTimeLine(event)}
          {event.location ? ` · ${event.location}` : ""}
          {people ? ` · ${people}` : ""}
        </span>
      </span>
    </button>
  );
}

export function CalendarScreen() {
  const premium = usePremium();
  const navigate = useNavigate();
  const [view, setView] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{
    open: boolean;
    edit: CalendarEvent | null;
  }>({ open: false, edit: null });

  // Grid range: the visible cells (month) or visible week, half-open [from, to).
  const gridDays = useMemo(
    () => (view === "month" ? monthGridDays(anchor) : undefined),
    [view, anchor],
  );
  const gridFrom = useMemo(
    () => (view === "month" ? gridDays![0]! : weekStart(anchor)),
    [view, gridDays, anchor],
  );
  const gridTo = useMemo(
    () =>
      new Date(
        gridFrom.getFullYear(),
        gridFrom.getMonth(),
        gridFrom.getDate() + (view === "month" ? 42 : 7),
      ),
    [gridFrom, view],
  );
  const grid = useCalendarEvents(gridFrom, gridTo);

  // Upcoming list: today → +90 days, independent of grid navigation.
  const upcomingFrom = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const upcomingTo = useMemo(
    () =>
      new Date(
        upcomingFrom.getFullYear(),
        upcomingFrom.getMonth(),
        upcomingFrom.getDate() + 90,
      ),
    [upcomingFrom],
  );
  const upcoming = useCalendarEvents(upcomingFrom, upcomingTo);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of grid.data ?? []) {
      const key = dayKey(new Date(e.startTime));
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [grid.data]);

  const shift = (dir: 1 | -1) => {
    const next = new Date(anchor);
    if (view === "month") next.setMonth(anchor.getMonth() + dir, 1);
    else next.setDate(anchor.getDate() + dir * 7);
    setAnchor(next);
    setSelectedDay(null);
  };

  const addEvent = () => {
    if (!premium) {
      toast(t("Premium feature — upgrade in Settings"));
      void navigate({ to: "/settings" });
      return;
    }
    setSheet({ open: true, edit: null });
  };

  // List content: the selected day's events, else the upcoming feed.
  const listEvents = selectedDay
    ? (byDay.get(selectedDay) ?? [])
    : (upcoming.data ?? []);
  // The selected-day list is fed by the grid query, not upcoming — gate the
  // empty state on whichever query actually feeds the visible list.
  const listLoading = selectedDay ? grid.isLoading : upcoming.isLoading;
  const listGroups = useMemo(() => {
    const groups: { day: Date; events: CalendarEvent[] }[] = [];
    for (const e of listEvents) {
      const d = new Date(e.startTime);
      const last = groups[groups.length - 1];
      if (last && dayKey(last.day) === dayKey(d)) last.events.push(e);
      else groups.push({ day: d, events: [e] });
    }
    return groups;
  }, [listEvents]);

  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(gridFrom);
        d.setDate(gridFrom.getDate() + i);
        return d;
      }),
    [gridFrom],
  );
  const cells = view === "month" ? gridDays! : weekDays;
  const todayKey = dayKey(new Date());

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <div className="flex items-center justify-between gap-2 py-4">
        <h1 className="text-2xl font-extrabold text-ink">{t("Calendar")}</h1>
        <ChipGroup
          options={[
            { value: "month", label: t("Month") },
            { value: "week", label: t("Week") },
          ]}
          value={view}
          onChange={(v) => {
            setView(v);
            setSelectedDay(null);
          }}
        />
      </div>

      <div className="space-y-3 pb-tabbar">
        <Card>
          <div className="flex items-center justify-between pb-2">
            <button
              type="button"
              aria-label={t("Previous")}
              onClick={() => shift(-1)}
              className="flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
            >
              <IconChevronLeft className="h-5 w-5" />
            </button>
            <p className="text-sm font-bold text-ink capitalize">
              {monthFmt.format(view === "month" ? anchor : gridFrom)}
            </p>
            <button
              type="button"
              aria-label={t("Next")}
              onClick={() => shift(1)}
              className="flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
            >
              <IconChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="grid grid-cols-7 pb-1">
            {weekDays.map((d) => (
              <p
                key={`h${d.getDay()}`}
                className="text-center text-[10px] font-semibold text-muted uppercase"
              >
                {weekdayFmt.format(d).replace(".", "")}
              </p>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-1">
            {cells.map((d) => {
              const key = dayKey(d);
              const inMonth =
                view === "week" || d.getMonth() === anchor.getMonth();
              const events = byDay.get(key) ?? [];
              const selected = selectedDay === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedDay(selected ? null : key)}
                  className={cn(
                    "flex h-11 flex-col items-center justify-center rounded-xl text-sm",
                    selected && "bg-surface-2",
                    key === todayKey && "font-extrabold text-accent",
                    inMonth ? "text-ink" : "text-muted/50",
                  )}
                >
                  {d.getDate()}
                  <span className="flex h-1.5 gap-0.5">
                    {events.slice(0, 3).map((e) => (
                      <span
                        key={e.id}
                        className="h-1.5 w-1.5 rounded-full"
                        style={{
                          background: calendarCategoryMeta[e.category].colorVar,
                        }}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Button size="full" onClick={addEvent}>
          <span className="inline-flex items-center gap-1.5">
            {premium ? (
              <IconPlus className="h-5 w-5" />
            ) : (
              <IconLock className="h-5 w-5" />
            )}
            {t("Add event")}
          </span>
        </Button>

        {(grid.isError || upcoming.isError) && (
          <ErrorState
            onRetry={() => {
              void grid.refetch();
              void upcoming.refetch();
            }}
          />
        )}

        <p className="pt-1 text-xs font-semibold tracking-wide text-muted uppercase">
          {selectedDay ? dayLabel(new Date(selectedDay)) : t("Upcoming")}
        </p>
        {listGroups.length === 0 &&
          !listLoading &&
          (premium ? (
            <p className="py-6 text-center text-sm text-muted">
              {t("No upcoming events")}
            </p>
          ) : (
            <Card className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                <IconLock className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {t("Calendar is a Premium feature")}
                </p>
                <p className="text-xs text-muted">
                  {t("Plan appointments and family events together.")}{" "}
                  <Link to="/settings" className="underline">
                    {t("Upgrade")}
                  </Link>
                </p>
              </div>
            </Card>
          ))}
        {listGroups.map((group) => (
          <div key={dayKey(group.day)}>
            {!selectedDay && (
              <p className="pt-2 pb-1 text-xs font-semibold text-ink-soft">
                {dayLabel(group.day)}
              </p>
            )}
            {group.events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                onTap={(e) => setSheet({ open: true, edit: e })}
              />
            ))}
          </div>
        ))}
      </div>

      <EventSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
        edit={sheet.edit}
      />
    </div>
  );
}
