import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateMedicineCatalogueEntry,
  MedicineCatalogueEntry,
  UpdateMedicineCatalogueEntry,
} from "@pjokk/shared";
import { client, unwrap } from "../api";

// The family's medicine catalogue (issue #49) — the contacts hooks over
// /api/medicines. The list is keyed per baby because `lastDoseAt` is
// answered for the baby asked about; the log mutations invalidate
// ["medicines"] as a whole so every baby's copy refreshes after a dose.

export function useMedicineCatalogue(babyId?: string, enabled = true) {
  return useQuery({
    queryKey: ["medicines", babyId ?? null],
    queryFn: async () =>
      unwrap<MedicineCatalogueEntry[]>(
        client.GET("/api/medicines", {
          params: { query: babyId ? { babyId } : {} },
        }),
      ),
    enabled,
  });
}

export function useSaveCatalogueMedicine(id?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      json: CreateMedicineCatalogueEntry | UpdateMedicineCatalogueEntry,
    ) =>
      id
        ? unwrap<MedicineCatalogueEntry>(
            client.PATCH("/api/medicines/{id}", {
              params: { path: { id } },
              body: json as UpdateMedicineCatalogueEntry,
            }),
          )
        : unwrap<MedicineCatalogueEntry>(
            client.POST("/api/medicines", {
              body: json as CreateMedicineCatalogueEntry,
            }),
          ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["medicines"] }),
  });
}

export function useDeleteCatalogueMedicine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        client.DELETE("/api/medicines/{id}", { params: { path: { id } } }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["medicines"] }),
  });
}
