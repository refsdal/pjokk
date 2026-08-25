import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Stats, Timeline, TimelineFilter } from "@shared/schemas";
import { api, unwrap } from "../api";

// Read-only aggregate views: the merged timeline and the stats window.

export function useTimeline(
  babyId: string | undefined,
  filter: TimelineFilter | null,
) {
  return useInfiniteQuery({
    queryKey: ["timeline", babyId, filter ?? "all"],
    enabled: !!babyId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap<Timeline>(
        await api.timeline.$get({
          query: {
            babyId: babyId!,
            limit: "50",
            ...(pageParam ? { before: pageParam } : {}),
            ...(filter ? { filter } : {}),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useStats(babyId: string | undefined, days: 7 | 30) {
  return useQuery({
    queryKey: ["stats", babyId, days],
    enabled: !!babyId,
    staleTime: 60_000,
    queryFn: async () =>
      unwrap<Stats>(
        await api.stats.$get({
          query: {
            babyId: babyId!,
            days: String(days),
            tz: String(new Date().getTimezoneOffset()),
          },
        }),
      ),
  });
}
