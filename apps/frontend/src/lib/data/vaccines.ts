import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaccineDismissal, VaccineLog } from "@pjokk/shared";
import { API_BASE, client, unwrap } from "../api";
import { downscaleImage } from "../image";
import { invalidateLogs } from "./keys";

export type CreateVaccineVars = {
  babyId: string;
  time: string;
  name: string;
  doseNumber?: number;
  scheduleSlot?: string;
  notes?: string;
};

export type UpdateVaccineVars = {
  id: string;
  patch: {
    time?: string;
    name?: string;
    doseNumber?: number | null;
    scheduleSlot?: string | null;
    notes?: string | null;
  };
};

export function useVaccines(babyId: string | undefined) {
  return useQuery({
    queryKey: ["vaccines", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<VaccineLog[]>(
        client.GET("/api/vaccines", {
          params: { query: { babyId: babyId!, limit: 200 } },
        }),
      ),
  });
}

export function useCreateVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: CreateVaccineVars) =>
      unwrap<VaccineLog>(client.POST("/api/vaccines", { body: vars })),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useUpdateVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: UpdateVaccineVars) =>
      unwrap<VaccineLog>(
        client.PATCH("/api/vaccines/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useDeleteVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(client.DELETE("/api/vaccines/{id}", { params: { path: { id } } })),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useVaccineDismissals(babyId: string | undefined) {
  return useQuery({
    queryKey: ["vaccine-dismissals", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<VaccineDismissal[]>(
        client.GET("/api/vaccines/dismissals", {
          params: { query: { babyId: babyId! } },
        }),
      ),
  });
}

export function useDismissVaccineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { babyId: string; slotKey: string }) =>
      unwrap<VaccineDismissal>(
        client.POST("/api/vaccines/dismissals", { body: vars }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useRestoreVaccineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        client.DELETE("/api/vaccines/dismissals/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}

// Multipart, so this one bypasses the RPC client. Images are downscaled
// before upload — a helsestasjon card photographed at 12 MP is a 4 MB file
// that reads perfectly well at 1600px.
export function useUploadVaccineDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", await downscaleImage(file));
      const res = await fetch(`${API_BASE}/api/vaccines/${id}/documents`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      return unwrap<{ id: string; url: string }>(res);
    },
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useDeleteVaccineDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await fetch(`${API_BASE}/api/files/${id}`, {
          method: "DELETE",
          credentials: "include",
        }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}
