import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { MeasurementType, MedicineUnit } from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

function toastMutationError(prefix: string, err: Error) {
  toast(prefix + err.message, "error");
}

// The six Phase 3 activity types: one generic client path for all of them.

export type OtherKind =
  | "medicine"
  | "bath"
  | "note"
  | "milestone"
  | "measurement"
  | "pump";

// Path templates per kind — dispatch is by kind and the per-kind payload
// types below keep call sites honest. client.GET/POST/PATCH/DELETE want a
// path LITERAL straight from the generated schema, which a
// runtime-dispatched string can't be, hence the `as never` casts on the
// four wrappers below (mirrors the old hono-client sub-objects' `as never`).
const otherListPath: Record<OtherKind, string> = {
  medicine: "/api/medicine",
  bath: "/api/baths",
  note: "/api/notes",
  milestone: "/api/milestones",
  measurement: "/api/measurements",
  pump: "/api/pumps",
};
const otherItemPath: Record<OtherKind, string> = {
  medicine: "/api/medicine/{id}",
  bath: "/api/baths/{id}",
  note: "/api/notes/{id}",
  milestone: "/api/milestones/{id}",
  measurement: "/api/measurements/{id}",
  pump: "/api/pumps/{id}",
};

function otherGet(kind: OtherKind, babyId: string, limit: number) {
  return client.GET(
    otherListPath[kind] as never,
    {
      params: { query: { babyId, limit } },
    } as never,
  );
}
function otherPost(kind: OtherKind, body: unknown) {
  return client.POST(otherListPath[kind] as never, { body } as never);
}
function otherPatch(kind: OtherKind, id: string, body: unknown) {
  return client.PATCH(
    otherItemPath[kind] as never,
    {
      params: { path: { id } },
      body,
    } as never,
  );
}
function otherDelete(kind: OtherKind, id: string) {
  return client.DELETE(
    otherItemPath[kind] as never,
    {
      params: { path: { id } },
    } as never,
  );
}

type OtherBase = { babyId: string; time: string; notes?: string };

export type CreateOtherVars =
  | ({ kind: "medicine" } & OtherBase & {
        name: string;
        amount?: number;
        unit?: MedicineUnit;
      })
  | ({ kind: "bath" } & OtherBase)
  | ({ kind: "note" } & OtherBase & { content: string })
  | ({ kind: "milestone" } & OtherBase & { title: string })
  | ({ kind: "measurement" } & OtherBase & {
        type: MeasurementType;
        value: number;
      })
  | ({ kind: "pump" } & OtherBase & {
        side?: "left" | "right" | "both";
        amountMl?: number;
        durationMin?: number;
      });

export interface UpdateOtherVars {
  kind: OtherKind;
  id: string;
  // Per-kind field set; omitted = untouched, null = cleared. Validated
  // server-side by the kind's generated request schema.
  patch: Record<string, unknown>;
}

export interface DeleteOtherVars {
  kind: OtherKind;
  id: string;
}

// Warm the per-kind prefill caches when the More picker opens, so the
// last-value prefill has data by the time a kind is chosen (first-ever open
// included).
export function prefetchOtherLists(qc: QueryClient, babyId: string) {
  for (const kind of Object.keys(otherListPath) as OtherKind[]) {
    void qc.prefetchQuery({
      queryKey: ["other", kind, babyId],
      queryFn: async () =>
        unwrap<Record<string, unknown>[]>(otherGet(kind, babyId, 10)),
      staleTime: 60_000,
    });
  }
}

export function useOtherList(
  kind: OtherKind,
  babyId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["other", kind, babyId],
    enabled: enabled && !!babyId,
    queryFn: async () =>
      unwrap<Record<string, unknown>[]>(otherGet(kind, babyId!, 10)),
  });
}

export function useMeasurements(babyId: string | undefined) {
  return useQuery({
    queryKey: ["other", "measurement", babyId, "all"],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<{ time: string; type: MeasurementType; value: number }[]>(
        otherGet("measurement", babyId!, 200),
      ),
  });
}

export function registerOtherMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["createOther"], {
    mutationFn: async ({ kind, ...body }: CreateOtherVars) =>
      unwrap(otherPost(kind, body)),
    onError: (err: Error) => toastMutationError(t("Could not save: "), err),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateOther"], {
    mutationFn: async ({ kind, id, patch }: UpdateOtherVars) =>
      unwrap(otherPatch(kind, id, patch)),
    onError: (err: Error) =>
      toast(t("Could not update: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteOther"], {
    mutationFn: async ({ kind, id }: DeleteOtherVars) =>
      unwrap(otherDelete(kind, id)),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
}

export function useCreateOther() {
  return useMutation<unknown, Error, CreateOtherVars>({
    mutationKey: ["createOther"],
  });
}

export function useUpdateOther() {
  return useMutation<unknown, Error, UpdateOtherVars>({
    mutationKey: ["updateOther"],
  });
}

export function useDeleteOther() {
  return useMutation<unknown, Error, DeleteOtherVars>({
    mutationKey: ["deleteOther"],
  });
}
