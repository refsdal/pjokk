import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { DiaperLog, FeedLog, SleepLog, Summary } from "@pjokk/shared";
import type { components } from "../api-schema";
import { client, unwrap } from "../api";
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
      unwrap<Summary>(
        client.GET("/api/summary", {
          params: {
            query: {
              babyId: babyId!,
              tz: new Date().getTimezoneOffset(),
            },
          },
        }),
      ),
  });
}

export function useFeeds(babyId: string | undefined, limit = 25) {
  return useQuery({
    queryKey: ["feeds", babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<FeedLog[]>(
        client.GET("/api/feeds", {
          params: { query: { babyId: babyId!, limit } },
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
        client.GET("/api/diapers", {
          params: { query: { babyId: babyId!, limit } },
        }),
      ),
  });
}

// The request shapes are the SPA's half of openapi/pjokk.yaml, so they are
// TAKEN from it rather than restated: `bun run gen:client` regenerates
// api-schema.d.ts, and a field or enum member that moves on the server stops
// this file compiling. These were hand-written until now, which meant every
// enum ("bottle" | "breast" | "solids", the six diaper colours, …) had a
// second definition that nothing checked against the first — and one had
// already drifted, CreateFeed's leftMin/rightMin being nullable on the wire
// and not here.
type Schemas = components["schemas"];

export type LogFeedVars = Schemas["CreateFeed"];
export type LogDiaperVars = Schemas["CreateDiaper"];

// POST /api/sleep starts a RUNNING session when endTime is absent and logs a
// finished one when it is present. This mutation is the former, so the field
// is omitted deliberately rather than left to the caller.
export type StartSleepVars = Omit<Schemas["CreateSleep"], "endTime">;

export interface WakeSleepVars {
  id: string;
  endTime?: string;
}

// Patch payloads: omitted = untouched, null = cleared. The nullability is
// the spec's, so it cannot fall out of step with what the server accepts.
export interface UpdateFeedVars {
  id: string;
  patch: Schemas["UpdateFeed"];
}

export interface UpdateDiaperVars {
  id: string;
  patch: Schemas["UpdateDiaper"];
}

// Reopens a finished sleep (lib/sleep-resume.ts). babyId is for the
// optimistic summary patch; the server needs only the id.
export interface ResumeSleepVars {
  id: string;
  babyId: string;
}

export interface UpdateSleepVars {
  id: string;
  patch: Schemas["UpdateSleep"];
}

export interface DeleteVars {
  id: string;
}

// Registered as defaults on the query client so offline-paused mutations can
// resume after a reload (persistQueryClient restores them by mutationKey).
export function registerLogMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["logFeed"], {
    mutationFn: async (vars: LogFeedVars) =>
      unwrap<FeedLog>(client.POST("/api/feeds", { body: vars })),
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
                contents: vars.contents ?? null,
                food: vars.food ?? null,
                reaction: vars.reaction ?? null,
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
      unwrap<DiaperLog>(client.POST("/api/diapers", { body: vars })),
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
                color: vars.color ?? null,
                consistency: vars.consistency ?? null,
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
      unwrap<SleepLog>(client.POST("/api/sleep", { body: vars })),
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
          type: vars.type ?? null,
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
        client.POST("/api/sleep/{id}/wake", {
          params: { path: { id } },
          body,
        }),
      ),
    onError: (err: Error) =>
      toast(`${t("Could not wake: ")}${err.message}`, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  // PATCH endTime: null — the one UpdateSleep write that can 409, when a
  // newer session is already running. Optimistic like startSleep, so the
  // banner is back at once (and offline, where the mutation pauses): the
  // last sleep becomes the active one, still counting from its start.
  qc.setMutationDefaults(["resumeSleep"], {
    mutationFn: async ({ id }: ResumeSleepVars) =>
      unwrap<SleepLog>(
        client.PATCH("/api/sleep/{id}", {
          params: { path: { id } },
          body: { endTime: null },
        }),
      ),
    onMutate: (vars: ResumeSleepVars) => {
      const snap = snapshotSummary(qc, vars.babyId);
      patchSummary(qc, vars.babyId, (old) =>
        !old.activeSleep && old.lastSleep?.id === vars.id
          ? { ...old, activeSleep: { ...old.lastSleep, endTime: null } }
          : old,
      );
      return snap;
    },
    onError: (err: Error, _vars: ResumeSleepVars, ctx: unknown) => {
      restoreSummary(qc, ctx);
      toast(`${t("Could not resume: ")}${err.message}`, "error");
    },
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateFeed"], {
    mutationFn: async ({ id, patch }: UpdateFeedVars) =>
      unwrap<FeedLog>(
        client.PATCH("/api/feeds/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: saveErrorToast("feed"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateDiaper"], {
    mutationFn: async ({ id, patch }: UpdateDiaperVars) =>
      unwrap<DiaperLog>(
        client.PATCH("/api/diapers/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: saveErrorToast("diaper"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateSleep"], {
    mutationFn: async ({ id, patch }: UpdateSleepVars) =>
      unwrap<SleepLog>(
        client.PATCH("/api/sleep/{id}", {
          params: { path: { id } },
          body: patch,
        }),
      ),
    onError: saveErrorToast("sleep"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteFeed"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(client.DELETE("/api/feeds/{id}", { params: { path: { id } } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteDiaper"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(client.DELETE("/api/diapers/{id}", { params: { path: { id } } })),
    onError: (err: Error) =>
      toast(t("Could not delete: ") + err.message, "error"),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteSleep"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(client.DELETE("/api/sleep/{id}", { params: { path: { id } } })),
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

export function useResumeSleep() {
  return useMutation<SleepLog, Error, ResumeSleepVars>({
    mutationKey: ["resumeSleep"],
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
