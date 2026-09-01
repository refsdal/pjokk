import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SleepLocation } from "@pjokk/shared";
import { client, unwrap } from "../api";

export function useSleepLocations() {
  return useQuery({
    queryKey: ["sleep-locations"],
    queryFn: async () =>
      unwrap<SleepLocation[]>(client.GET("/api/sleep-locations")),
  });
}

export function useAddSleepLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap<SleepLocation>(
        client.POST("/api/sleep-locations", { body: { name } }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["sleep-locations"] }),
  });
}

export function useDeleteSleepLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        client.DELETE("/api/sleep-locations/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["sleep-locations"] }),
  });
}
