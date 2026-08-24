import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  Baby,
  DiaperLog,
  FeedLog,
  Invite,
  MeasurementType,
  MedicineUnit,
  Member,
  SleepLog,
  Stats,
  Summary,
  Timeline,
  TimelineFilter,
} from "@shared/schemas";
import { api, unwrap } from "./api";

// --- Phase 3 activity types: one generic client path for all six ---

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
    $get: (args: { query: { babyId: string; limit: string } }) => Promise<Response>;
    $post: (args: { json: unknown }) => Promise<Response>;
  } & Record<
    ":id",
    {
      $patch: (args: { param: { id: string }; json: unknown }) => Promise<Response>;
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

export function useTimeline(
  babyId: string | undefined,
  filter: TimelineFilter | null,
) {
  return useInfiniteQuery({
    queryKey: ["timeline", babyId, filter ?? "all"],
    enabled: !!babyId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap<Timeline>(
        await api.timeline.$get({
          query: {
            babyId: babyId!,
            limit: "50",
            ...(pageParam ? { before: pageParam } : {}),
            ...(filter ? { filter } : {}),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useStats(babyId: string | undefined, days: 7 | 30) {
  return useQuery({
    queryKey: ["stats", babyId, days],
    enabled: !!babyId,
    staleTime: 60_000,
    queryFn: async () =>
      unwrap<Stats>(
        await api.stats.$get({
          query: {
            babyId: babyId!,
            days: String(days),
            tz: String(new Date().getTimezoneOffset()),
          },
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

// Patch payloads: omitted = untouched, null = cleared.
export interface UpdateFeedVars {
  id: string;
  patch: {
    time?: string;
    type?: "bottle" | "breast" | "solids";
    amountMl?: number | null;
    side?: "left" | "right" | "both" | null;
    durationMin?: number | null;
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

// --- Phase 3 vars: discriminated by kind ---

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

const invalidateLogs = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: ["summary"] });
  void qc.invalidateQueries({ queryKey: ["feeds"] });
  void qc.invalidateQueries({ queryKey: ["diapers"] });
  void qc.invalidateQueries({ queryKey: ["sleep"] });
  void qc.invalidateQueries({ queryKey: ["timeline"] });
  void qc.invalidateQueries({ queryKey: ["other"] });
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
  qc.setMutationDefaults(["updateFeed"], {
    mutationFn: async ({ id, patch }: UpdateFeedVars) =>
      unwrap<FeedLog>(
        await api.feeds[":id"].$patch({ param: { id }, json: patch }),
      ),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateDiaper"], {
    mutationFn: async ({ id, patch }: UpdateDiaperVars) =>
      unwrap<DiaperLog>(
        await api.diapers[":id"].$patch({ param: { id }, json: patch }),
      ),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateSleep"], {
    mutationFn: async ({ id, patch }: UpdateSleepVars) =>
      unwrap<SleepLog>(
        await api.sleep[":id"].$patch({ param: { id }, json: patch }),
      ),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteFeed"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.feeds[":id"].$delete({ param: { id } })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteDiaper"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.diapers[":id"].$delete({ param: { id } })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteSleep"], {
    mutationFn: async ({ id }: DeleteVars) =>
      unwrap(await api.sleep[":id"].$delete({ param: { id } })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["createOther"], {
    mutationFn: async ({ kind, ...body }: CreateOtherVars) =>
      unwrap(await otherApi[kind].$post({ json: body })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["updateOther"], {
    mutationFn: async ({ kind, id, patch }: UpdateOtherVars) =>
      unwrap(await otherApi[kind][":id"].$patch({ param: { id }, json: patch })),
    onSettled: () => invalidateLogs(qc),
  });
  qc.setMutationDefaults(["deleteOther"], {
    mutationFn: async ({ kind, id }: DeleteOtherVars) =>
      unwrap(await otherApi[kind][":id"].$delete({ param: { id } })),
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
