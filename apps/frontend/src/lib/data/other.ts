import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { MeasurementType } from "@pjokk/shared";
import type { components } from "../api-schema";
import { caretakerInit, client, unwrap } from "../api";
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
function otherPost(kind: OtherKind, body: unknown, caretakerId?: string) {
  return client.POST(
    otherListPath[kind] as never,
    { body, ...caretakerInit(caretakerId) } as never,
  );
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
function otherDelete(kind: OtherKind, id: string, caretakerId?: string) {
  return client.DELETE(
    otherItemPath[kind] as never,
    {
      params: { path: { id } },
      ...caretakerInit(caretakerId),
    } as never,
  );
}

// The per-kind payloads come from openapi/pjokk.yaml via api-schema.d.ts,
// not from a second hand-written copy: `bun run gen:client` regenerates
// them, and a field the server adds or an enum member it drops stops this
// file compiling. `kind` is the client's own discriminator — it selects the
// path above and is stripped before the body is sent.
type Schemas = components["schemas"];

// caretakerId: who is logging on a kiosk (lib/api.ts's caretakerInit).
export type CreateOtherVars = { caretakerId?: string } & (
  | ({ kind: "medicine" } & Schemas["CreateMedicine"])
  | ({ kind: "bath" } & Schemas["CreateBath"])
  | ({ kind: "note" } & Schemas["CreateNote"])
  | ({ kind: "milestone" } & Schemas["CreateMilestone"])
  | ({ kind: "measurement" } & Schemas["CreateMeasurement"])
  | ({ kind: "pump" } & Schemas["CreatePump"])
);

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
  caretakerId?: string;
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
    mutationFn: async ({ kind, caretakerId, ...body }: CreateOtherVars) =>
      unwrap(otherPost(kind, body, caretakerId)),
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
    mutationFn: async ({ kind, id, caretakerId }: DeleteOtherVars) =>
      unwrap(otherDelete(kind, id, caretakerId)),
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
