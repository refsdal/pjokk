import {
  IconBabyBottle,
  IconDiaper,
  IconMoon,
  IconNote,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useState } from "react";
import type { TimelineEntry, TimelineFilter } from "@shared/schemas";
import { DiaperSheet } from "@/components/sheets/DiaperSheet";
import { FeedSheet } from "@/components/sheets/FeedSheet";
import {
  OtherLogSheet,
  otherKindMeta,
  type OtherEntry,
} from "@/components/sheets/OtherLogSheet";
import { SleepSheet } from "@/components/sheets/SleepSheet";
import { ChipGroup } from "@/components/Chips";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { Button } from "@/components/ui/button";
import { useBabies, useFeeds, useTimeline } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatClock, formatDay, formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

const entryTime = (e: TimelineEntry): Date =>
  new Date(e.kind === "sleep" ? e.startTime : e.time);

function dayLabel(d: Date, now = new Date()): string {
  if (d.toDateString() === now.toDateString()) return t("Today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return t("Yesterday");
  return formatDay(d);
}

function daySummary(entries: TimelineEntry[]): string {
  const feeds = entries.filter((e) => e.kind === "feed").length;
  const naps = entries.filter((e) => e.kind === "sleep").length;
  const diapers = entries.filter((e) => e.kind === "diaper").length;
  const other = entries.length - feeds - naps - diapers;
  const parts = [
    feeds > 0 ? `${feeds} ${feeds === 1 ? t("feed") : t("feeds")}` : null,
    naps > 0 ? `${naps} ${naps === 1 ? t("nap") : t("naps")}` : null,
    diapers > 0
      ? `${diapers} ${diapers === 1 ? t("diaper") : t("diapers")}`
      : null,
    other > 0 ? `${other} ${t("other")}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

const diaperLabel: Record<string, string> = {
  wet: "Wet diaper",
  dirty: "Dirty diaper",
  both: "Wet + dirty diaper",
};

function entryMain(e: TimelineEntry): { title: string; detail: string | null } {
  if (e.kind === "feed") {
    if (e.type === "bottle")
      return { title: t("Bottle"), detail: `${e.amountMl ?? "?"} ml` };
    if (e.type === "breast")
      return {
        title: t("Breast"),
        detail: [e.side, e.durationMin ? `${e.durationMin} min` : null]
          .filter(Boolean)
          .join(" · "),
      };
    return {
      title: t("Solids"),
      detail: e.amountMl ? `${e.amountMl} ml` : null,
    };
  }
  if (e.kind === "diaper") {
    return { title: t(diaperLabel[e.type] ?? "Diaper"), detail: null };
  }
  if (e.kind === "sleep") {
    const start = new Date(e.startTime);
    if (!e.endTime) {
      return {
        title: t("Sleep"),
        detail: `${t("since")} ${formatClock(start)}`,
      };
    }
    const end = new Date(e.endTime);
    return {
      title: t("Sleep"),
      detail: `${formatClock(start)}–${formatClock(end)} · ${formatDuration(end.getTime() - start.getTime())}`,
    };
  }
  if (e.kind === "medicine") {
    return {
      title: e.name,
      detail: e.amount != null ? `${e.amount} ${e.unit ?? ""}`.trim() : null,
    };
  }
  if (e.kind === "bath") {
    return { title: t("Bath"), detail: null };
  }
  if (e.kind === "note") {
    return { title: t("Note"), detail: e.content };
  }
  if (e.kind === "milestone") {
    return { title: t("Milestone"), detail: e.title };
  }
  if (e.kind === "measurement") {
    const label =
      e.type === "weight"
        ? t("Weight")
        : e.type === "length"
          ? t("Length")
          : t("Head");
    return {
      title: label,
      detail: `${e.value.toFixed(1)} ${e.type === "weight" ? "kg" : "cm"}`,
    };
  }
  return {
    title: t("Pump"),
    detail: [e.side, e.amountMl != null ? `${e.amountMl} ml` : null]
      .filter(Boolean)
      .join(" · "),
  };
}

const kindStyle: Record<
  TimelineEntry["kind"],
  { icon: TablerIcon; tint: string }
> = {
  feed: { icon: IconBabyBottle, tint: "text-feed" },
  diaper: { icon: IconDiaper, tint: "text-diaper" },
  sleep: { icon: IconMoon, tint: "text-sleep" },
  medicine: otherKindMeta.medicine,
  bath: otherKindMeta.bath,
  note: otherKindMeta.note,
  milestone: otherKindMeta.milestone,
  measurement: otherKindMeta.measurement,
  pump: otherKindMeta.pump,
};

function Row({
  entry,
  onClick,
}: {
  entry: TimelineEntry;
  onClick: () => void;
}) {
  const { icon: Icon, tint } = kindStyle[entry.kind];
  const { title, detail } = entryMain(entry);
  const active = entry.kind === "sleep" && !entry.endTime;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 px-1 py-1.5 text-left active:bg-surface-2"
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2",
          tint,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
        <span className="font-semibold">{title}</span>
        {detail && <span className="text-ink-soft"> · {detail}</span>}
        {entry.notes && (
          <IconNote className="ml-1.5 inline h-3.5 w-3.5 text-muted" />
        )}
        {active && (
          <span className="ml-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
            {t("active")}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-semibold tabular-nums text-ink">
          {formatClock(entryTime(entry))}
        </span>
        <span className="block text-[11px] text-muted">
          {t("by")} {entry.caretakerName}
        </span>
      </span>
    </button>
  );
}

export function TimelineScreen() {
  const babies = useBabies();
  const baby = babies.data?.[0];
  const [filter, setFilter] = useState<TimelineFilter | null>(null);
  const timeline = useTimeline(baby?.id, filter);
  const feeds = useFeeds(baby?.id);
  const [editEntry, setEditEntry] = useState<TimelineEntry | null>(null);

  const entries = timeline.data?.pages.flatMap((p) => p.entries) ?? [];

  // Group consecutive entries by local day (already sorted newest-first).
  const groups: { key: string; date: Date; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const d = entryTime(entry);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, date: d, entries: [entry] });
  }

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <h1 className="py-4 text-2xl font-extrabold text-ink">{t("Timeline")}</h1>

      <ChipGroup
        className="flex-nowrap overflow-x-auto pb-3"
        options={[
          { value: "all", label: t("All") },
          { value: "feeds", label: t("Feeds") },
          { value: "sleep", label: t("Sleep") },
          { value: "diapers", label: t("Diapers") },
          { value: "other", label: t("Other") },
        ]}
        value={filter ?? "all"}
        onChange={(v) => setFilter(v === "all" ? null : (v as TimelineFilter))}
      />

      <div className="pb-tabbar">
        {timeline.isPending && <LoadingState />}
        {timeline.isError && (
          <ErrorState onRetry={() => void timeline.refetch()} />
        )}
        {timeline.isSuccess && entries.length === 0 && (
          <p className="py-16 text-center text-sm text-muted">
            {t("Nothing here yet — log something from Home.")}
          </p>
        )}

        {groups.map((group) => (
          <section key={group.key} className="pb-2">
            <header className="flex items-baseline justify-between px-1 pt-3 pb-1">
              <h2 className="text-sm font-bold text-ink">
                {dayLabel(group.date)}
              </h2>
              <p className="text-xs text-muted">{daySummary(group.entries)}</p>
            </header>
            <div className="divide-y divide-line">
              {group.entries.map((entry) => (
                <Row
                  key={`${entry.kind}-${entry.id}`}
                  entry={entry}
                  onClick={() => setEditEntry(entry)}
                />
              ))}
            </div>
          </section>
        ))}

        {timeline.hasNextPage && (
          <Button
            size="full"
            variant="outline"
            className="mt-3"
            disabled={timeline.isFetchingNextPage}
            onClick={() => void timeline.fetchNextPage()}
          >
            {timeline.isFetchingNextPage ? t("Loading…") : t("Load more")}
          </Button>
        )}
      </div>

      <FeedSheet
        open={editEntry?.kind === "feed"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={baby?.id ?? ""}
        recentFeeds={feeds.data ?? []}
        edit={editEntry?.kind === "feed" ? editEntry : null}
      />
      <DiaperSheet
        open={editEntry?.kind === "diaper"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={baby?.id ?? ""}
        lastDiaper={null}
        edit={editEntry?.kind === "diaper" ? editEntry : null}
      />
      <SleepSheet
        open={editEntry?.kind === "sleep"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={baby?.id ?? ""}
        lastLocation={null}
        edit={editEntry?.kind === "sleep" ? editEntry : null}
      />
      {(() => {
        const otherEdit =
          editEntry &&
          editEntry.kind !== "feed" &&
          editEntry.kind !== "diaper" &&
          editEntry.kind !== "sleep"
            ? (editEntry as OtherEntry)
            : null;
        return (
          <OtherLogSheet
            open={!!otherEdit}
            onOpenChange={(o) => !o && setEditEntry(null)}
            babyId={baby?.id ?? ""}
            kind={otherEdit?.kind ?? "medicine"}
            edit={otherEdit}
          />
        );
      })()}
    </div>
  );
}
