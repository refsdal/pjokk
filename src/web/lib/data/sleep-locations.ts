import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SleepLocation } from "@shared/schemas";
import { api, unwrap } from "../api";

export function useSleepLocations() {
  return useQuery({
    queryKey: ["sleep-locations"],
    queryFn: async () =>
      unwrap<SleepLocation[]>(await api["sleep-locations"].$get()),
  });
}

export function useAddSleepLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap<SleepLocation>(
        await api["sleep-locations"].$post({ json: { name } }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["sleep-locations"] }),
  });
}

export function useDeleteSleepLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api["sleep-locations"][":id"].$delete({ param: { id } })),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["sleep-locations"] }),
  });
}
