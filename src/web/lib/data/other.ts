import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { MeasurementType, MedicineUnit } from "@shared/schemas";
import { api, ApiError, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// Server 402s for a gated kind carry `code: "PLAN_REQUIRED"` — surface the
// friendly upgrade copy instead of the raw server message in that case.
function toastMutationError(prefix: string, err: Error) {
  if (err instanceof ApiError && err.code === "PLAN_REQUIRED") {
    toast(t("Premium feature — upgrade in Settings"), "error");
    return;
  }
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

// Heterogeneously typed hono-client sub-objects; dispatch is by kind and the
// per-kind payload types below keep call sites honest.
const otherApi: Record<
  OtherKind,
  {
    $get: (args: {
      query: { babyId: string; limit: string };
    }) => Promise<Response>;
    $post: (args: { json: unknown }) => Promise<Response>;
  } & Record<
    ":id",
    {
      $patch: (args: {
        param: { id: string };
        json: unknown;
      }) => Promise<Response>;
      $delete: (args: { param: { id: string } }) => Promise<Response>;
    }
  >
> = {
  medicine: api.medicine as never,
  bath: api.baths as never,
  note: api.notes as never,
  milestone: api.milestones as never,
  measurement: api.measurements as never,
  pump: api.pumps as never,
};

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
  // server-side by the kind's zod schema.
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
  for (const kind of Object.keys(otherApi) as OtherKind[]) {
    void qc.prefetchQuery({
      queryKey: ["other", kind, babyId],
      queryFn: async () =>
        unwrap<Record<string, unknown>[]>(
          await otherApi[kind].$get({ query: { babyId, limit: "10" } }),
        ),
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
      unwrap<Record<string, unknown>[]>(
        await otherApi[kind].$get({
          query: { babyId: babyId!, limit: "10" },
        }),
      ),
  });
}

export function useMeasurements(babyId: string | undefined) {
  return useQuery({
    queryKey: ["other", "measurement", babyId, "all"],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<
        { time: string; type: "weight" | "length" | "head"; value: number }[]
      >(
        await api.measurements.$get({
          query: { babyId: babyId!, limit: "200" },
        }),
      ),
  });
}

export function registerOtherMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["createOther"], {
    mutationFn: async ({ kind, ...body }: CreateOtherVars) =>
      unwrap(await otherApi[kind].$post({ json: body })),
    onError: (err: Error) => toastMutationError(t("Could not save: "), err),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateOther"], {
    mutationFn: async ({ kind, id, patch }: UpdateOtherVars) =>
      unwrap(
        await otherApi[kind][":id"].$patch({ param: { id }, json: patch }),
      ),
    onError: (err: Error) =>
      toast(t("Could not update: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteOther"], {
    mutationFn: async ({ kind, id }: DeleteOtherVars) =>
      unwrap(await otherApi[kind][":id"].$delete({ param: { id } })),
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
