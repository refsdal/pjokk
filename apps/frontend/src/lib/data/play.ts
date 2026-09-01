import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { PlayLog, PlayType, Summary } from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// Play timers follow the sleep-session pattern all the way down, including
// the offline-resumable mutation defaults: starting a walk with no signal
// must not fail, so the summary is patched optimistically and the mutation
// resumes on reconnect.

const OPTIMISTIC_ID = "optimistic";

export type StartPlayVars = {
  babyId: string;
  type: PlayType;
  startTime: string;
  notes?: string;
};
export type LogPlayVars = StartPlayVars & { endTime: string };
export type StopPlayVars = { id: string; endTime?: string };
export type UpdatePlayVars = {
  id: string;
  patch: {
    type?: PlayType;
    startTime?: string;
    endTime?: string | null;
    notes?: string | null;
  };
};
export type DeletePlayVars = { id: string };

export function usePlays(babyId: string | undefined, limit = 25) {
  return useQuery({
    queryKey: ["play", babyId, limit],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<PlayLog[]>(
        client.GET("/api/play", {
          params: { query: { babyId: babyId!, limit } },
        }),
      ),
  });
}

export function registerPlayMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["startPlay"], {
    mutationFn: async (vars: StartPlayVars) =>
      unwrap<PlayLog>(client.POST("/api/play", { body: vars })),
    onMutate: (vars: StartPlayVars) => {
      const previous = qc.getQueryData<Summary>(["summary", vars.babyId]);
      qc.setQueryData<Summary>(["summary", vars.babyId], (old) =>
        old
          ? {
              ...old,
              activePlay: old.activePlay ?? {
                id: OPTIMISTIC_ID,
                babyId: vars.babyId,
                caretakerId: "",
                caretakerName: "",
                type: vars.type,
                startTime: vars.startTime,
                endTime: null,
                notes: null,
              },
            }
          : old,
      );
      return { babyId: vars.babyId, previous };
    },
    onError: (err: Error, _vars: StartPlayVars, ctx: unknown) => {
      const snap = ctx as { babyId: string; previous?: Summary } | undefined;
      if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
      toast(
        `${t("Could not save")} (${t("activity")}): ${err.message}`,
        "error",
      );
    },
    onSettled: () => invalidateLogs(qc),
  });
  // A finished session logged after the fact — no active-state patching.
  qc.setMutationDefaults(["logPlay"], {
    mutationFn: async (vars: LogPlayVars) =>
      unwrap<PlayLog>(client.POST("/api/play", { body: vars })),
    onError: (err: Error) =>
      toast(
        `${t("Could not save")} (${t("activity")}): ${err.message}`,
        "error",
      ),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["stopPlay"], {
    mutationFn: async ({ id, ...body }: StopPlayVars) =>
      unwrap<PlayLog>(
        client.POST("/api/play/{id}/stop", {
          params: { path: { id } },
          body,
        }),
      ),
    onError: (err: Error) =>
      toast(`${t("Could not stop: ")}${err.message}`, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updatePlay"], {
    mutationFn: async ({ id, patch }: UpdatePlayVars) =>
      unwrap<PlayLog>(
        client.PATCH("/api/play/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: (err: Error) =>
      toast(
        `${t("Could not save")} (${t("activity")}): ${err.message}`,
        "error",
      ),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deletePlay"], {
    mutationFn: async ({ id }: DeletePlayVars) =>
      unwrap(client.DELETE("/api/play/{id}", { params: { path: { id } } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
}

export function useStartPlay() {
  return useMutation<PlayLog, Error, StartPlayVars>({
    mutationKey: ["startPlay"],
  });
}

export function useLogPlay() {
  return useMutation<PlayLog, Error, LogPlayVars>({ mutationKey: ["logPlay"] });
}

export function useStopPlay() {
  return useMutation<PlayLog, Error, StopPlayVars>({
    mutationKey: ["stopPlay"],
  });
}

export function useUpdatePlay() {
  return useMutation<PlayLog, Error, UpdatePlayVars>({
    mutationKey: ["updatePlay"],
  });
}

export function useDeletePlay() {
  return useMutation<unknown, Error, DeletePlayVars>({
    mutationKey: ["deletePlay"],
  });
}
