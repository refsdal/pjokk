import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { DiaperLog, FeedLog, SleepLog, Summary } from "@shared/schemas";
import { api, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// Optimistic pseudo-entries: the home glance must reflect a log IMMEDIATELY
// (especially offline, where the mutation pauses and onSettled never runs
// until reconnect). caretakerName is blank — the status cards don't show it.
const OPTIMISTIC_ID = "optimistic";

type SummarySnapshot = { babyId: string; previous: Summary | undefined };

function snapshotSummary(qc: QueryClient, babyId: string): SummarySnapshot {
  return {
    babyId,
    previous: qc.getQueryData<Summary>(["summary", babyId]),
  };
}

function restoreSummary(qc: QueryClient, ctx: unknown) {
  const snap = ctx as SummarySnapshot | undefined;
  if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
}

function patchSummary(
  qc: QueryClient,
  babyId: string,
  patch: (old: Summary) => Summary,
) {
  qc.setQueryData<Summary>(["summary", babyId], (old) =>
    old ? patch(old) : old,
  );
}

const saveErrorToast = (what: string) => (err: Error) =>
  toast(`${t("Could not save")} (${t(what)}): ${err.message}`, "error");

// Core-loop queries + offline-resumable mutations (feed / diaper / sleep).

export function useSummary(babyId: string | undefined) {
  return useQuery({
    queryKey: ["summary", babyId],
    enabled: !!babyId,
    // The home screen is a glance: keep it current while open.
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap<Summary>(await api.summary.$get({ query: { babyId: babyId! } })),
  });
}

export function useFeeds(babyId: string | undefined, limit = 25) {
  return useQuery({
    queryKey: ["feeds", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<FeedLog[]>(
        await api.feeds.$get({
          query: { babyId: babyId!, limit: String(limit) },
        }),
      ),
  });
}

export function useDiapers(babyId: string | undefined, limit = 25) {
  return useQuery({
    queryKey: ["diapers", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<DiaperLog[]>(
        await api.diapers.$get({
          query: { babyId: babyId!, limit: String(limit) },
        }),
      ),
  });
}

export interface LogFeedVars {
  babyId: string;
  time: string;
  type: "bottle" | "breast" | "solids";
  amountMl?: number;
  side?: "left" | "right" | "both";
  durationMin?: number;
  leftMin?: number;
  rightMin?: number;
  notes?: string;
}

export interface LogDiaperVars {
  babyId: string;
  time: string;
  type: "wet" | "dirty" | "both";
  notes?: string;
}

export interface StartSleepVars {
  babyId: string;
  startTime: string;
  location?: string;
}

export interface WakeSleepVars {
  id: string;
  endTime?: string;
}

// Patch payloads: omitted = untouched, null = cleared.
export interface UpdateFeedVars {
  id: string;
  patch: {
    time?: string;
    type?: "bottle" | "breast" | "solids";
    amountMl?: number | null;
    side?: "left" | "right" | "both" | null;
    durationMin?: number | null;
    leftMin?: number | null;
    rightMin?: number | null;
    notes?: string | null;
  };
}

export interface UpdateDiaperVars {
  id: string;
  patch: {
    time?: string;
    type?: "wet" | "dirty" | "both";
    notes?: string | null;
  };
}

export interface UpdateSleepVars {
  id: string;
  patch: {
    startTime?: string;
    endTime?: string | null;
    location?: string | null;
    notes?: string | null;
  };
}

export interface DeleteVars {
  id: string;
}

// Registered as defaults on the query client so offline-paused mutations can
// resume after a reload (persistQueryClient restores them by mutationKey).
export function registerLogMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["logFeed"], {
    mutationFn: async (vars: LogFeedVars) =>
      unwrap<FeedLog>(await api.feeds.$post({ json: vars })),
    onMutate: (vars: LogFeedVars) => {
      const snap = snapshotSummary(qc, vars.babyId);
      patchSummary(qc, vars.babyId, (old) =>
        !old.lastFeed || vars.time >= old.lastFeed.time
          ? {
              ...old,
              lastFeed: {
                id: OPTIMISTIC_ID,
                babyId: vars.babyId,
                caretakerId: "",
                caretakerName: "",
                time: vars.time,
                type: vars.type,
                amountMl: vars.amountMl ?? null,
                side: vars.side ?? null,
                durationMin: vars.durationMin ?? null,
                leftMin: vars.leftMin ?? null,
                rightMin: vars.rightMin ?? null,
                notes: null,
              },
            }
          : old,
      );
      return snap;
    },
    onError: (err: Error, _vars: LogFeedVars, ctx: unknown) => {
      restoreSummary(qc, ctx);
      saveErrorToast("feed")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["logDiaper"], {
    mutationFn: async (vars: LogDiaperVars) =>
      unwrap<DiaperLog>(await api.diapers.$post({ json: vars })),
    onMutate: (vars: LogDiaperVars) => {
      const snap = snapshotSummary(qc, vars.babyId);
      patchSummary(qc, vars.babyId, (old) =>
        !old.lastDiaper || vars.time >= old.lastDiaper.time
          ? {
              ...old,
              lastDiaper: {
                id: OPTIMISTIC_ID,
                babyId: vars.babyId,
                caretakerId: "",
                caretakerName: "",
                time: vars.time,
                type: vars.type,
                notes: null,
              },
            }
          : old,
      );
      return snap;
    },
    onError: (err: Error, _vars: LogDiaperVars, ctx: unknown) => {
      restoreSummary(qc, ctx);
      saveErrorToast("diaper")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["startSleep"], {
    mutationFn: async (vars: StartSleepVars) =>
      unwrap<SleepLog>(await api.sleep.$post({ json: vars })),
    onMutate: (vars: StartSleepVars) => {
      const snap = snapshotSummary(qc, vars.babyId);
      patchSummary(qc, vars.babyId, (old) => ({
        ...old,
        activeSleep: old.activeSleep ?? {
          id: OPTIMISTIC_ID,
          babyId: vars.babyId,
          caretakerId: "",
          caretakerName: "",
          startTime: vars.startTime,
          endTime: null,
          location: vars.location ?? null,
          notes: null,
        },
      }));
      return snap;
    },
    onError: (err: Error, _vars: StartSleepVars, ctx: unknown) => {
      restoreSummary(qc, ctx);
      saveErrorToast("sleep")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["wakeSleep"], {
    mutationFn: async ({ id, ...body }: WakeSleepVars) =>
      unwrap<SleepLog>(
        await api.sleep[":id"].wake.$post({ param: { id }, json: body }),
      ),
    onError: (err: Error) =>
      toast(`${t("Could not wake: ")}${err.message}`, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateFeed"], {
    mutationFn: async ({ id, patch }: UpdateFeedVars) =>
      unwrap<FeedLog>(
        await api.feeds[":id"].$patch({ param: { id }, json: patch }),
      ),
    onError: saveErrorToast("feed"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateDiaper"], {
    mutationFn: async ({ id, patch }: UpdateDiaperVars) =>
      unwrap<DiaperLog>(
        await api.diapers[":id"].$patch({ param: { id }, json: patch }),
      ),
    onError: saveErrorToast("diaper"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateSleep"], {
    mutationFn: async ({ id, patch }: UpdateSleepVars) =>
      unwrap<SleepLog>(
        await api.sleep[":id"].$patch({ param: { id }, json: patch }),
      ),
    onError: saveErrorToast("feed"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteFeed"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.feeds[":id"].$delete({ param: { id } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteDiaper"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.diapers[":id"].$delete({ param: { id } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteSleep"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.sleep[":id"].$delete({ param: { id } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
}

export function useLogFeed() {
  return useMutation<FeedLog, Error, LogFeedVars>({ mutationKey: ["logFeed"] });
}

export function useLogDiaper() {
  return useMutation<DiaperLog, Error, LogDiaperVars>({
    mutationKey: ["logDiaper"],
  });
}

export function useStartSleep() {
  return useMutation<SleepLog, Error, StartSleepVars>({
    mutationKey: ["startSleep"],
  });
}

export function useWakeSleep() {
  return useMutation<SleepLog, Error, WakeSleepVars>({
    mutationKey: ["wakeSleep"],
  });
}

export function useUpdateFeed() {
  return useMutation<FeedLog, Error, UpdateFeedVars>({
    mutationKey: ["updateFeed"],
  });
}

export function useUpdateDiaper() {
  return useMutation<DiaperLog, Error, UpdateDiaperVars>({
    mutationKey: ["updateDiaper"],
  });
}

export function useUpdateSleep() {
  return useMutation<SleepLog, Error, UpdateSleepVars>({
    mutationKey: ["updateSleep"],
  });
}

export function useDeleteFeed() {
  return useMutation<unknown, Error, DeleteVars>({
    mutationKey: ["deleteFeed"],
  });
}

export function useDeleteDiaper() {
  return useMutation<unknown, Error, DeleteVars>({
    mutationKey: ["deleteDiaper"],
  });
}

export function useDeleteSleep() {
  return useMutation<unknown, Error, DeleteVars>({
    mutationKey: ["deleteSleep"],
  });
}
