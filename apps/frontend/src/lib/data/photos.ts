import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE, unwrap } from "../api";
import { downscaleImage } from "../image";
import { invalidateLogs } from "./keys";

// Photos on milestones (issue #48). Multipart in, so the upload bypasses
// the typed RPC client, like vaccine documents. The photo itself is served
// by /api/photos/{id} (an <img src>), never a public bucket URL.

export interface MilestonePhoto {
  id: string;
  width: number;
  height: number;
  size: number;
  url: string;
}

export function photoSrc(photo: { url: string }): string {
  return `${API_BASE}${photo.url}`;
}

export function useUploadMilestonePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", await downscaleImage(file));
      const res = await fetch(`${API_BASE}/api/milestones/${id}/photos`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      return unwrap<MilestonePhoto>(res);
    },
    onSettled: () => {
      invalidateLogs(qc);
      void qc.invalidateQueries({ queryKey: ["photoUsage"] });
    },
  });
}

export function useDeleteMilestonePhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await fetch(`${API_BASE}/api/photos/${id}`, {
          method: "DELETE",
          credentials: "include",
        }),
      ),
    onSettled: () => {
      invalidateLogs(qc);
      void qc.invalidateQueries({ queryKey: ["photoUsage"] });
    },
  });
}

/** Settings → Data: bytes stored against the family's quota (0 = none). */
export function usePhotoUsage() {
  return useQuery({
    queryKey: ["photoUsage"],
    queryFn: async () =>
      unwrap<{ bytes: number; quotaBytes: number }>(
        await fetch(`${API_BASE}/api/photos/usage`, { credentials: "include" }),
      ),
  });
}

export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}
