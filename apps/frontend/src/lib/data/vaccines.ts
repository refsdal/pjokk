import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaccineDismissal, VaccineLog } from "@pjokk/shared";
import { API_BASE, api, unwrap } from "../api";
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
        await api.vaccines.$get({
          query: { babyId: babyId!, limit: "200" },
        }),
      ),
  });
}

export function useCreateVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: CreateVaccineVars) =>
      unwrap<VaccineLog>(await api.vaccines.$post({ json: vars })),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useUpdateVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: UpdateVaccineVars) =>
      unwrap<VaccineLog>(
        await api.vaccines[":id"].$patch({ param: { id }, json: patch }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useDeleteVaccine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.vaccines[":id"].$delete({ param: { id } })),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useVaccineDismissals(babyId: string | undefined) {
  return useQuery({
    queryKey: ["vaccine-dismissals", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<VaccineDismissal[]>(
        await api.vaccines.dismissals.$get({ query: { babyId: babyId! } }),
      ),
  });
}

export function useDismissVaccineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { babyId: string; slotKey: string }) =>
      unwrap<VaccineDismissal>(
        await api.vaccines.dismissals.$post({ json: vars }),
      ),
    onSuccess: () => invalidateLogs(qc),
  });
}

export function useRestoreVaccineSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.vaccines.dismissals[":id"].$delete({ param: { id } })),
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

const MAX_EDGE = 1600;

async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_000_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    if (!blob) return file;
    const renamed = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${renamed}.jpg`, { type: "image/jpeg" });
  } catch {
    // HEIC that the browser can't decode, canvas unavailable, … — send the
    // original and let the server's allowlist and size cap decide.
    return file;
  }
}
