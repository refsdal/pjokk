import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { DaycareLog, Summary } from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// A day at barnehage (issue #105) follows the play-session pattern, which
// follows sleep's, down to the offline-resumable mutation defaults: a
// drop-off logged at the gate with no signal must not fail, so the summary
// is patched optimistically and the mutation resumes on reconnect.

const OPTIMISTIC_ID = "optimistic";

export type DropOffVars = {
  babyId: string;
  startTime: string;
  notes?: string;
  // Who dropped off (spec 2026-09-14-who-did-it); the caller by default.
  caretakerId?: string;
};
export type LogDaycareVars = DropOffVars & {
  endTime: string;
  pickupCaretakerId?: string;
};
export type PickUpVars = { id: string; endTime?: string; caretakerId?: string };
export type UpdateDaycareVars = {
  id: string;
  patch: {
    startTime?: string;
    endTime?: string | null;
    notes?: string | null;
    caretakerId?: string;
    pickupCaretakerId?: string | null;
  };
};
export type DeleteDaycareVars = { id: string };

const saveError = (err: Error) =>
  toast(`${t("Could not save")} (${t("Daycare")}): ${err.message}`, "error");

export function registerDaycareMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["dropOff"], {
    mutationFn: async (vars: DropOffVars) =>
      unwrap<DaycareLog>(client.POST("/api/daycare", { body: vars })),
    onMutate: (vars: DropOffVars) => {
      const previous = qc.getQueryData<Summary>(["summary", vars.babyId]);
      qc.setQueryData<Summary>(["summary", vars.babyId], (old) =>
        old
          ? {
              ...old,
              activeDaycare: old.activeDaycare ?? {
                id: OPTIMISTIC_ID,
                babyId: vars.babyId,
                caretakerId: "",
                caretakerName: "",
                loggedById: "",
                loggedByName: "",
                pickupCaretakerId: null,
                pickupCaretakerName: null,
                startTime: vars.startTime,
                endTime: null,
                notes: vars.notes ?? null,
              },
            }
          : old,
      );
      return { babyId: vars.babyId, previous };
    },
    onError: (err: Error, _vars: DropOffVars, ctx: unknown) => {
      const snap = ctx as { babyId: string; previous?: Summary } | undefined;
      if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
      saveError(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  // A finished day logged after the fact — no active-state patching.
  qc.setMutationDefaults(["logDaycare"], {
    mutationFn: async (vars: LogDaycareVars) =>
      unwrap<DaycareLog>(client.POST("/api/daycare", { body: vars })),
    onError: saveError,
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["pickUp"], {
    mutationFn: async ({ id, ...body }: PickUpVars) =>
      unwrap<DaycareLog>(
        client.POST("/api/daycare/{id}/pickup", {
          params: { path: { id } },
          body,
        }),
      ),
    onError: saveError,
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateDaycare"], {
    mutationFn: async ({ id, patch }: UpdateDaycareVars) =>
      unwrap<DaycareLog>(
        client.PATCH("/api/daycare/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: saveError,
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteDaycare"], {
    mutationFn: async ({ id }: DeleteDaycareVars) =>
      unwrap(client.DELETE("/api/daycare/{id}", { params: { path: { id } } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
}

export function useDropOff() {
  return useMutation<DaycareLog, Error, DropOffVars>({
    mutationKey: ["dropOff"],
  });
}

export function useLogDaycare() {
  return useMutation<DaycareLog, Error, LogDaycareVars>({
    mutationKey: ["logDaycare"],
  });
}

export function usePickUp() {
  return useMutation<DaycareLog, Error, PickUpVars>({
    mutationKey: ["pickUp"],
  });
}

export function useUpdateDaycare() {
  return useMutation<DaycareLog, Error, UpdateDaycareVars>({
    mutationKey: ["updateDaycare"],
  });
}

export function useDeleteDaycare() {
  return useMutation<unknown, Error, DeleteDaycareVars>({
    mutationKey: ["deleteDaycare"],
  });
}
