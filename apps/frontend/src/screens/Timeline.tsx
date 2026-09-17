import { IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { TimelineFilter } from "@pjokk/shared";
import { BabyHeader } from "@/components/BabyHeader";
import { ChipGroup } from "@/components/Chips";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { TimelineList } from "@/components/TimelineList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTimeline } from "@/lib/data";
import { t } from "@/lib/i18n";
import { useSelectedBaby } from "@/lib/selected-baby";
import { useTracking } from "@/lib/tracking";
import { cn } from "@/lib/utils";

// The Timeline tab: header, search, filter chips and paging. The rows,
// the day groups and the edit sheets live in components/TimelineList.tsx,
// shared with Home's Recent pane.

export function TimelineScreen() {
  const { baby } = useSelectedBaby();
  const [filter, setFilter] = useState<TimelineFilter | null>(null);
  // The chips are the ENABLED kinds (spec
  // 2026-09-17-per-baby-tracking-design.md); All still shows the history
  // of a kind that was switched off.
  const track = useTracking(baby);
  const chipOptions: { value: TimelineFilter | "all"; label: string }[] = [
    { value: "all", label: t("All") },
    ...(track.has("feeds")
      ? [{ value: "feeds" as const, label: t("Feeds") }]
      : []),
    ...(track.has("sleep")
      ? [{ value: "sleep" as const, label: t("Sleep") }]
      : []),
    ...(track.has("diapers")
      ? [{ value: "diapers" as const, label: t("Diapers") }]
      : []),
    ...(track.anyMore ? [{ value: "other" as const, label: t("Other") }] : []),
  ];
  const chipKeys = chipOptions.map((o) => o.value).join(",");
  // A filter left over from before a switch went off: back to All.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chipKeys stands for chipOptions
  useEffect(() => {
    if (filter && !chipKeys.split(",").includes(filter)) setFilter(null);
  }, [filter, chipKeys]);
  // Search (issue #52): the field shows on demand so the default screen
  // stays dense; the term is debounced so a query is not fired per key.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const term = search.trim();
    if (term === q) return;
    const id = setTimeout(() => setQ(term), 300);
    return () => clearTimeout(id);
  }, [search, q]);
  const timeline = useTimeline(baby?.id, filter, q);
  const entries = timeline.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-2xl md:px-6">
      <BabyHeader />
      <div className="flex items-center justify-between gap-2 pt-1 pb-3">
        <h1 className="text-2xl font-extrabold text-ink">{t("Timeline")}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t("Search")}
            aria-pressed={searchOpen}
            onClick={() => {
              if (searchOpen) {
                setSearch("");
                setQ("");
              }
              setSearchOpen((o) => !o);
            }}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink-soft active:bg-surface-2",
              searchOpen && "border-accent text-accent",
            )}
          >
            <IconSearch className="h-5 w-5" />
          </button>
        </div>
      </div>
      {searchOpen && (
        <Input
          // biome-ignore lint/a11y/noAutofocus: the field appears on the user's own tap.
          autoFocus
          type="search"
          placeholder={t("Search notes, medicines, milestones…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3"
        />
      )}

      <ChipGroup
        className="flex-nowrap overflow-x-auto pb-3"
        options={chipOptions}
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
            {q
              ? t("No entries match your search.")
              : t("Nothing here yet — log something from Home.")}
          </p>
        )}

        <TimelineList babyId={baby?.id} entries={entries} />

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
    </div>
  );
}
