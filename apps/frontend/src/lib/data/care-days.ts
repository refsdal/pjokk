import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CareDay, CareDays } from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";

// Days at home with an ill child (issue #108). Ordinary online mutations,
// not offline-resumable defaults: this is bookkeeping done on the sofa, not
// a log taken in the dark, and a save that fails should say so at once.

const KEY = "care-days";

export function useCareDays(year: number, on = true) {
  return useQuery({
    queryKey: [KEY, year],
    enabled: on,
    queryFn: async () =>
      unwrap<CareDays>(
        client.GET("/api/care-days", { params: { query: { year } } }),
      ),
  });
}

const failed = (err: Error) =>
  toast(`${t("Could not save")}: ${err.message}`, "error");

export type AddCareDayVars = {
  date: string;
  userId?: string;
  fraction?: 0.5 | 1;
  illnessId?: string;
  note?: string;
};

export function useAddCareDay() {
  const qc = useQueryClient();
  return useMutation<CareDay, Error, AddCareDayVars>({
    mutationFn: async (body) =>
      unwrap<CareDay>(client.POST("/api/care-days", { body })),
    onError: failed,
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateCareDay() {
  const qc = useQueryClient();
  return useMutation<
    CareDay,
    Error,
    { id: string; patch: { fraction?: 0.5 | 1; note?: string | null } }
  >({
    mutationFn: async ({ id, patch }) =>
      unwrap<CareDay>(
        client.PATCH("/api/care-days/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: failed,
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useRemoveCareDay() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string }>({
    mutationFn: async ({ id }) =>
      unwrap(
        client.DELETE("/api/care-days/{id}", { params: { path: { id } } }),
      ),
    onError: failed,
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useSetCareDayQuota() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { userId?: string; days: number | null }>({
    mutationFn: async (body) =>
      unwrap(client.PUT("/api/care-days/quota", { body })),
    onError: failed,
    onSettled: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
