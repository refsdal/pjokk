import { isFever, measurementMeta } from "@/lib/measurements";
import {
  IconBabyBottle,
  IconDiaper,
  IconMoon,
  IconNote,
  IconVaccine,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useState } from "react";
import type { TimelineEntry } from "@pjokk/shared";
import { DiaperSheet } from "@/components/sheets/DiaperSheet";
import { FeedSheet } from "@/components/sheets/FeedSheet";
import {
  OtherLogSheet,
  otherKindMeta,
  type OtherEntry,
} from "@/components/sheets/OtherLogSheet";
import { PlaySheet } from "@/components/sheets/PlaySheet";
import { SleepSheet } from "@/components/sheets/SleepSheet";
import { VaccineSheet } from "@/components/sheets/VaccineSheet";
import { Avatar } from "@/components/Avatar";
import { useFeeds, useMedicineCatalogue, useMemberAvatars } from "@/lib/data";
import { t } from "@/lib/i18n";
import { diaperDetail, feedDetail, sleepTitle } from "@/lib/log-detail";
import { photoSrc } from "@/lib/data/photos";
import {
  formatMeasurementIn,
  formatVolume,
  type Units,
  useUnits,
} from "@/lib/units";
import { playKindMeta } from "@/lib/play-ui";
import { nextDoseFrom } from "@/lib/medicine-ui";
import { formatClock, formatDay, formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

// The day-grouped dense list plus tap-to-edit through the log sheets —
// shared by the Timeline tab and Home's Recent pane (spec §4). Extracted
// from screens/Timeline.tsx, which keeps the header, search, filter chips
// and paging; this owns the rows and the edit-sheet state.

// Sessions (sleep, play) sort and display by their start time.
const entryTime = (e: TimelineEntry): Date =>
  new Date(e.kind === "sleep" || e.kind === "play" ? e.startTime : e.time);

function dayLabel(d: Date, now = new Date()): string {
  if (d.toDateString() === now.toDateString()) return t("Today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return t("Yesterday");
  return formatDay(d);
}

export function daySummary(entries: TimelineEntry[]): string {
  const feeds = entries.filter((e) => e.kind === "feed").length;
  const sleeps = entries.filter((e) => e.kind === "sleep").length;
  // A night is its own part, never a nap (lib/sleep-ui.ts has the split).
  const nights = entries.filter(
    (e) => e.kind === "sleep" && e.type === "night",
  ).length;
  const naps = sleeps - nights;
  const diapers = entries.filter((e) => e.kind === "diaper").length;
  const other = entries.length - feeds - sleeps - diapers;
  const parts = [
    feeds > 0 ? `${feeds} ${feeds === 1 ? t("feed") : t("feeds")}` : null,
    naps > 0 ? `${naps} ${naps === 1 ? t("nap") : t("naps")}` : null,
    nights > 0 ? `${nights} ${nights === 1 ? t("night") : t("nights")}` : null,
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
  dry: "Dry diaper",
};

function entryMain(
  e: TimelineEntry,
  units: Units,
): { title: string; detail: string | null } {
  if (e.kind === "feed") {
    if (e.type === "bottle")
      return {
        title: t("Bottle"),
        detail: feedDetail(
          e.amountMl == null ? "?" : formatVolume(e.amountMl, units),
          e,
        ),
      };
    if (e.type === "breast")
      return {
        title: t("Breast"),
        detail: [e.side, e.durationMin ? `${e.durationMin} min` : null]
          .filter(Boolean)
          .join(" · "),
      };
    return {
      title: t("Solids"),
      detail: feedDetail(e.amountMl ? `${e.amountMl} g` : null, e),
    };
  }
  if (e.kind === "diaper") {
    return {
      title: t(diaperLabel[e.type] ?? "Diaper"),
      detail: diaperDetail(e),
    };
  }
  if (e.kind === "sleep") {
    const start = new Date(e.startTime);
    if (!e.endTime) {
      return {
        title: sleepTitle(e.type),
        detail: `${t("since")} ${formatClock(start)}`,
      };
    }
    const end = new Date(e.endTime);
    return {
      title: sleepTitle(e.type),
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
    // Label and unit both come from the shared table — re-deriving the unit
    // here as `weight ? kg : cm` is what made temperatures render as lengths.
    return {
      title: t(measurementMeta[e.type].label),
      detail: formatMeasurementIn(e.type, e.value, units),
    };
  }
  if (e.kind === "play") {
    const start = new Date(e.startTime);
    const title = t(playKindMeta[e.type].label);
    if (!e.endTime) {
      return { title, detail: `${t("since")} ${formatClock(start)}` };
    }
    const end = new Date(e.endTime);
    return {
      title,
      detail: `${formatClock(start)}–${formatClock(end)} · ${formatDuration(end.getTime() - start.getTime())}`,
    };
  }
  if (e.kind === "vaccine") {
    return {
      title: e.name,
      detail: e.doseNumber ? `${t("Dose")} ${e.doseNumber}` : null,
    };
  }
  return {
    title: t("Pump"),
    detail: [
      e.side,
      e.amountMl != null ? formatVolume(e.amountMl, units) : null,
    ]
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
  // Every play type shares the row icon; the title carries which one.
  play: { icon: playKindMeta.tummy.icon, tint: playKindMeta.tummy.tint },
  vaccine: { icon: IconVaccine, tint: "text-growth" },
};

function Row({
  entry,
  avatarUrl,
  nextDose = null,
  onClick,
}: {
  entry: TimelineEntry;
  avatarUrl: string | null | undefined;
  // The medicine catalogue's "next dose OK from" (issue #49), only on the
  // newest dose of an entry with an interval, while it is still ahead.
  nextDose?: Date | null;
  onClick: () => void;
}) {
  const { icon: Icon, tint: baseTint } = kindStyle[entry.kind];
  const units = useUnits();
  const { title, detail } = entryMain(entry, units);
  // A fever is the one measurement worth spotting while scrolling back
  // through a sick week, so it takes the danger token instead of the usual
  // growth tint. Everything else stays calm.
  const fever =
    entry.kind === "measurement" && isFever(entry.type, entry.value);
  const tint = fever ? "text-danger" : baseTint;
  const active =
    (entry.kind === "sleep" || entry.kind === "play") && !entry.endTime;
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
        {nextDose && (
          // Short on purpose: the row is one line, and the sheet says it
          // in full.
          <span
            className="font-semibold text-caution"
            title={`${t("Next dose OK from")} ${formatClock(nextDose)}`}
          >
            {" "}
            · {t("next")} {formatClock(nextDose)}
          </span>
        )}
        {entry.notes && (
          <IconNote className="ml-1.5 inline h-3.5 w-3.5 text-muted" />
        )}
        {active && (
          <span className="ml-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
            {t("active")}
          </span>
        )}
      </span>
      {entry.kind === "milestone" && entry.photos.length > 0 && (
        // The first photo, at row height: the reason a family opens the
        // timeline a year later.
        <img
          src={photoSrc(entry.photos[0]!)}
          alt=""
          className="h-10 w-10 shrink-0 rounded-lg object-cover"
        />
      )}
      <span className="shrink-0 text-right">
        <span className="block text-sm font-semibold tabular-nums text-ink">
          {formatClock(entryTime(entry))}
        </span>
        <span className="block text-[11px] text-muted">
          {t("by")} {entry.caretakerName}
        </span>
      </span>
      <Avatar src={avatarUrl} name={entry.caretakerName} size={8} />
    </button>
  );
}

// Day groups: consecutive entries (already newest-first) by local day.
export function groupByDay(
  entries: TimelineEntry[],
): { key: string; date: Date; entries: TimelineEntry[] }[] {
  const groups: { key: string; date: Date; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const d = entryTime(entry);
    const key = d.toDateString();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, date: d, entries: [entry] });
  }
  return groups;
}

export function TimelineList({
  babyId,
  entries,
}: {
  babyId: string | undefined;
  entries: TimelineEntry[];
}) {
  const feeds = useFeeds(babyId);
  const avatars = useMemberAvatars();
  const [editEntry, setEditEntry] = useState<TimelineEntry | null>(null);
  // The catalogue for THIS baby carries each entry's newest linked dose;
  // the row that IS that dose gets the "next dose OK from" note.
  const catalogue = useMedicineCatalogue(babyId, !!babyId);
  const nextDoseFor = (entry: TimelineEntry): Date | null => {
    if (entry.kind !== "medicine" || !entry.medicineId) return null;
    const m = (catalogue.data ?? []).find((c) => c.id === entry.medicineId);
    if (!m || !m.lastDoseAt) return null;
    if (new Date(m.lastDoseAt).getTime() !== new Date(entry.time).getTime())
      return null;
    return nextDoseFrom(m);
  };
  const groups = groupByDay(entries);
  const otherEdit =
    editEntry &&
    editEntry.kind !== "feed" &&
    editEntry.kind !== "diaper" &&
    editEntry.kind !== "sleep" &&
    editEntry.kind !== "play" &&
    editEntry.kind !== "vaccine"
      ? (editEntry as OtherEntry)
      : null;

  return (
    <>
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
                avatarUrl={avatars[entry.caretakerId]}
                nextDose={nextDoseFor(entry)}
                onClick={() => setEditEntry(entry)}
              />
            ))}
          </div>
        </section>
      ))}

      <FeedSheet
        open={editEntry?.kind === "feed"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        recentFeeds={feeds.data ?? []}
        edit={editEntry?.kind === "feed" ? editEntry : null}
      />
      <DiaperSheet
        open={editEntry?.kind === "diaper"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        lastDiaper={null}
        edit={editEntry?.kind === "diaper" ? editEntry : null}
      />
      <SleepSheet
        open={editEntry?.kind === "sleep"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        lastLocation={null}
        edit={editEntry?.kind === "sleep" ? editEntry : null}
      />
      <PlaySheet
        open={editEntry?.kind === "play"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        edit={editEntry?.kind === "play" ? editEntry : null}
      />
      <VaccineSheet
        open={editEntry?.kind === "vaccine"}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        edit={editEntry?.kind === "vaccine" ? editEntry : null}
      />
      <OtherLogSheet
        open={!!otherEdit}
        onOpenChange={(o) => !o && setEditEntry(null)}
        babyId={babyId ?? ""}
        kind={otherEdit?.kind ?? "medicine"}
        edit={otherEdit}
      />
    </>
  );
}
