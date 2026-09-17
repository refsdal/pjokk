import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { IllnessLog, IllnessSymptom, Summary } from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// Illness episodes (issue #107): the daycare-session pattern again — state
// on the summary, offline-resumable mutation defaults, an optimistic patch
// for opening one so the card is there at once.

const OPTIMISTIC_ID = "optimistic";

export type StartIllnessVars = {
  babyId: string;
  startTime: string;
  endTime?: string;
  symptoms: IllnessSymptom[];
  clearHours?: number | null;
  notes?: string;
  caretakerId?: string;
};
export type RecoverIllnessVars = { id: string; endTime?: string };
export type UpdateIllnessVars = {
  id: string;
  // For the optimistic patch of the open episode on Home.
  babyId: string;
  patch: {
    startTime?: string;
    endTime?: string | null;
    symptoms?: IllnessSymptom[];
    lastSymptomAt?: string | null;
    clearHours?: number | null;
    notes?: string | null;
    caretakerId?: string;
  };
};
export type DeleteIllnessVars = { id: string };

const saveError = (err: Error) =>
  toast(`${t("Could not save")} (${t("Illness")}): ${err.message}`, "error");

export function registerIllnessMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["startIllness"], {
    mutationFn: async (vars: StartIllnessVars) =>
      unwrap<IllnessLog>(client.POST("/api/illness", { body: vars })),
    onMutate: (vars: StartIllnessVars) => {
      const previous = qc.getQueryData<Summary>(["summary", vars.babyId]);
      if (vars.endTime) return { babyId: vars.babyId, previous };
      qc.setQueryData<Summary>(["summary", vars.babyId], (old) =>
        old
          ? {
              ...old,
              activeIllness: old.activeIllness ?? {
                id: OPTIMISTIC_ID,
                babyId: vars.babyId,
                caretakerId: "",
                caretakerName: "",
                loggedById: "",
                loggedByName: "",
                startTime: vars.startTime,
                endTime: null,
                symptoms: vars.symptoms,
                lastSymptomAt: null,
                clearHours: vars.clearHours ?? null,
                notes: vars.notes ?? null,
              },
            }
          : old,
      );
      return { babyId: vars.babyId, previous };
    },
    onError: (err: Error, _vars: StartIllnessVars, ctx: unknown) => {
      const snap = ctx as { babyId: string; previous?: Summary } | undefined;
      if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
      saveError(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["recoverIllness"], {
    mutationFn: async ({ id, ...body }: RecoverIllnessVars) =>
      unwrap<IllnessLog>(
        client.POST("/api/illness/{id}/recover", {
          params: { path: { id } },
          body,
        }),
      ),
    onError: saveError,
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateIllness"], {
    mutationFn: async ({ id, patch }: UpdateIllnessVars) =>
      unwrap<IllnessLog>(
        client.PATCH("/api/illness/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    // The card's two buttons are taps on a clock: it must move at once,
    // signal or no signal.
    onMutate: ({ id, babyId, patch }: UpdateIllnessVars) => {
      const previous = qc.getQueryData<Summary>(["summary", babyId]);
      qc.setQueryData<Summary>(["summary", babyId], (old) =>
        old?.activeIllness?.id === id
          ? { ...old, activeIllness: { ...old.activeIllness, ...patch } }
          : old,
      );
      return { babyId, previous };
    },
    onError: (err: Error, _vars: UpdateIllnessVars, ctx: unknown) => {
      const snap = ctx as { babyId: string; previous?: Summary } | undefined;
      if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
      saveError(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteIllness"], {
    mutationFn: async ({ id }: DeleteIllnessVars) =>
      unwrap(client.DELETE("/api/illness/{id}", { params: { path: { id } } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
}

export const useStartIllness = () =>
  useMutation<IllnessLog, Error, StartIllnessVars>({
    mutationKey: ["startIllness"],
  });
export const useRecoverIllness = () =>
  useMutation<IllnessLog, Error, RecoverIllnessVars>({
    mutationKey: ["recoverIllness"],
  });
export const useUpdateIllness = () =>
  useMutation<IllnessLog, Error, UpdateIllnessVars>({
    mutationKey: ["updateIllness"],
  });
export const useDeleteIllness = () =>
  useMutation<unknown, Error, DeleteIllnessVars>({
    mutationKey: ["deleteIllness"],
  });
