import {
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  Baby,
  DiaperLog,
  FeedLog,
  Invite,
  Member,
  SleepLog,
  Summary,
} from "@shared/schemas";
import { api, unwrap } from "./api";

// --- queries ---

export function useBabies() {
  return useQuery({
    queryKey: ["babies"],
    queryFn: async () => unwrap<Baby[]>(await api.babies.$get()),
  });
}

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

export function useMembers() {
  return useQuery({
    queryKey: ["members"],
    queryFn: async () => unwrap<Member[]>(await api.family.members.$get()),
  });
}

export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: ["invites"],
    enabled,
    queryFn: async () => unwrap<Invite[]>(await api.invites.$get()),
  });
}

// --- mutations ---
// Registered as defaults on the query client so offline-paused mutations can
// resume after a reload (persistQueryClient restores them by mutationKey).

export interface LogFeedVars {
  babyId: string;
  time: string;
  type: "bottle" | "breast" | "solids";
  amountMl?: number;
  side?: "left" | "right" | "both";
  durationMin?: number;
}

export interface LogDiaperVars {
  babyId: string;
  time: string;
  type: "wet" | "dirty" | "both";
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

const invalidateLogs = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ["summary"] });
  void qc.invalidateQueries({ queryKey: ["feeds"] });
  void qc.invalidateQueries({ queryKey: ["diapers"] });
  void qc.invalidateQueries({ queryKey: ["sleep"] });
};

export function registerMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["logFeed"], {
    mutationFn: async (vars: LogFeedVars) =>
      unwrap<FeedLog>(await api.feeds.$post({ json: vars })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["logDiaper"], {
    mutationFn: async (vars: LogDiaperVars) =>
      unwrap<DiaperLog>(await api.diapers.$post({ json: vars })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["startSleep"], {
    mutationFn: async (vars: StartSleepVars) =>
      unwrap<SleepLog>(await api.sleep.$post({ json: vars })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["wakeSleep"], {
    mutationFn: async ({ id, ...body }: WakeSleepVars) =>
      unwrap<SleepLog>(
        await api.sleep[":id"].wake.$post({ param: { id }, json: body }),
      ),
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
