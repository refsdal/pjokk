import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Stats, Timeline, TimelineFilter } from "@pjokk/shared";
import { client, unwrap } from "../api";

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
        client.GET("/api/timeline", {
          params: {
            query: {
              babyId: babyId!,
              limit: 50,
              ...(pageParam ? { before: pageParam } : {}),
              ...(filter ? { filter } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useStats(babyId: string | undefined, days: 1 | 7 | 30) {
  return useQuery({
    queryKey: ["stats", babyId, days],
    enabled: !!babyId,
    staleTime: 60_000,
    queryFn: async () =>
      unwrap<Stats>(
        client.GET("/api/stats", {
          params: {
            query: {
              babyId: babyId!,
              days,
              tz: new Date().getTimezoneOffset(),
            },
          },
        }),
      ),
  });
}
