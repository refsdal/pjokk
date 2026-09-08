import { TimelineList } from "@/components/TimelineList";
import { useTimeline } from "@/lib/data";
import { useTier } from "@/lib/layout";

// Home's middle pane at the wide tier (spec §4): the first page of the
// selected baby's timeline — no filter, no search, no paging — so a desktop
// answers "what has happened today" without leaving Home. Hidden below xl
// by CSS AND not fetched there (the query is enabled only at wide).
export function HomeRecent({ babyId }: { babyId: string }) {
  const wide = useTier() === "wide";
  const timeline = useTimeline(babyId, null, "", wide);
  const entries = timeline.data?.pages[0]?.entries ?? [];
  return (
    <section
      data-testid="home-recent"
      className="hidden min-w-0 xl:block xl:pt-6"
    >
      <TimelineList babyId={babyId} entries={entries} />
    </section>
  );
}
