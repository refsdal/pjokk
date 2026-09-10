import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { FeedLog, FeedTimer, PumpLog, Summary } from "@pjokk/shared";
import { caretakerInit, client, unwrap } from "../api";
import { sideSeconds } from "../feed-timer-ui";
import { t } from "../i18n";
import { toast } from "../toast";
import { invalidateLogs } from "./keys";

// The shared nursing / pump timer (issue #44) follows the sleep-session
// pattern all the way down: the running state rides on /api/summary
// (activeFeed / activePump), every mutation patches it optimistically and
// is offline-resumable. The start carries the client's own startTime, so a
// replayed start still begins the clock where the parent tapped it; the
// switch/stop/discard need the server-issued id and are therefore disabled
// in the UI while the start is still "optimistic".

const OPTIMISTIC_ID = "optimistic";

// caretakerId: who is logging on a kiosk (lib/api.ts's caretakerInit).
export type StartFeedTimerVars = {
  caretakerId?: string;
  babyId: string;
  kind: "breast" | "pump";
  side?: "left" | "right" | "both";
  startTime: string;
};
export type SetFeedTimerSideVars = {
  caretakerId?: string;
  id: string;
  babyId: string;
  side: "left" | "right" | "both" | null;
};
export type StopFeedTimerVars = {
  caretakerId?: string;
  id: string;
  babyId: string;
  kind: "breast" | "pump";
  time?: string;
  leftMin?: number;
  rightMin?: number;
  amountMl?: number;
  side?: "left" | "right" | "both";
  durationMin?: number;
  notes?: string;
};
export type DiscardFeedTimerVars = {
  id: string;
  babyId: string;
  kind: "breast" | "pump";
};
export type FeedTimerStopped = {
  kind: "breast" | "pump";
  feed: FeedLog | null;
  pump: PumpLog | null;
};

const slot = (kind: "breast" | "pump") =>
  kind === "pump" ? "activePump" : "activeFeed";

type Snapshot = { babyId: string; previous: Summary | undefined };

function patchTimer(
  qc: QueryClient,
  babyId: string,
  kind: "breast" | "pump",
  value: FeedTimer | null | ((old: FeedTimer) => FeedTimer),
): Snapshot {
  const previous = qc.getQueryData<Summary>(["summary", babyId]);
  qc.setQueryData<Summary>(["summary", babyId], (old) => {
    if (!old) return old;
    const key = slot(kind);
    const current = old[key];
    const next =
      typeof value === "function"
        ? current
          ? value(current)
          : current
        : value;
    return { ...old, [key]: next };
  });
  return { babyId, previous };
}

function restore(qc: QueryClient, ctx: unknown) {
  const snap = ctx as Snapshot | undefined;
  if (snap) qc.setQueryData(["summary", snap.babyId], snap.previous);
}

const fail = (what: string) => (err: Error) =>
  toast(`${t("Could not save")} (${t(what)}): ${err.message}`, "error");

export function registerFeedTimerMutationDefaults(qc: QueryClient) {
  qc.setMutationDefaults(["startFeedTimer"], {
    mutationFn: async ({ caretakerId, ...body }: StartFeedTimerVars) =>
      unwrap<FeedTimer>(
        client.POST("/api/feeds/timer", {
          body,
          ...caretakerInit(caretakerId),
        }),
      ),
    onMutate: (vars: StartFeedTimerVars) =>
      patchTimer(qc, vars.babyId, vars.kind, {
        id: OPTIMISTIC_ID,
        babyId: vars.babyId,
        caretakerId: "",
        caretakerName: "",
        kind: vars.kind,
        startTime: vars.startTime,
        runningSide: vars.side ?? (vars.kind === "pump" ? "both" : "left"),
        sideStartedAt: vars.startTime,
        leftSec: 0,
        rightSec: 0,
      }),
    onError: (err: Error, _vars: StartFeedTimerVars, ctx: unknown) => {
      restore(qc, ctx);
      fail("timer")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });

  qc.setMutationDefaults(["setFeedTimerSide"], {
    mutationFn: async ({ id, side, caretakerId }: SetFeedTimerSideVars) =>
      unwrap<FeedTimer>(
        client.POST("/api/feeds/timer/{id}/side", {
          params: { path: { id } },
          body: { side },
          ...caretakerInit(caretakerId),
        }),
      ),
    // Bank the running stretch locally the way the server will, so the
    // sheet's clocks do not jump when the answer arrives.
    onMutate: (vars: SetFeedTimerSideVars) => {
      const now = Date.now();
      return patchTimer(qc, vars.babyId, "breast", (old) => ({
        ...old,
        leftSec: sideSeconds(old, "left", now),
        rightSec: sideSeconds(old, "right", now),
        runningSide: vars.side,
        sideStartedAt: vars.side ? new Date(now).toISOString() : null,
      }));
    },
    onError: (err: Error, _vars: SetFeedTimerSideVars, ctx: unknown) => {
      restore(qc, ctx);
      fail("timer")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });

  qc.setMutationDefaults(["stopFeedTimer"], {
    mutationFn: async ({
      id,
      babyId: _b,
      kind: _k,
      caretakerId,
      ...body
    }: StopFeedTimerVars) =>
      unwrap<FeedTimerStopped>(
        client.POST("/api/feeds/timer/{id}/stop", {
          params: { path: { id } },
          body,
          ...caretakerInit(caretakerId),
        }),
      ),
    onMutate: (vars: StopFeedTimerVars) =>
      patchTimer(qc, vars.babyId, vars.kind, null),
    onError: (err: Error, _vars: StopFeedTimerVars, ctx: unknown) => {
      restore(qc, ctx);
      fail(_vars.kind === "pump" ? "pump" : "feed")(err);
    },
    onSettled: () => invalidateLogs(qc),
  });

  qc.setMutationDefaults(["discardFeedTimer"], {
    mutationFn: async ({ id }: DiscardFeedTimerVars) =>
      unwrap(
        client.DELETE("/api/feeds/timer/{id}", { params: { path: { id } } }),
      ),
    onMutate: (vars: DiscardFeedTimerVars) =>
      patchTimer(qc, vars.babyId, vars.kind, null),
    onError: (err: Error, _vars: DiscardFeedTimerVars, ctx: unknown) => {
      restore(qc, ctx);
      toast(`${t("Could not discard the timer")}: ${err.message}`, "error");
    },
    onSettled: () => invalidateLogs(qc),
  });
}

export function useStartFeedTimer() {
  return useMutation<FeedTimer, Error, StartFeedTimerVars>({
    mutationKey: ["startFeedTimer"],
  });
}
export function useSetFeedTimerSide() {
  return useMutation<FeedTimer, Error, SetFeedTimerSideVars>({
    mutationKey: ["setFeedTimerSide"],
  });
}
export function useStopFeedTimer() {
  return useMutation<FeedTimerStopped, Error, StopFeedTimerVars>({
    mutationKey: ["stopFeedTimer"],
  });
}
export function useDiscardFeedTimer() {
  return useMutation<unknown, Error, DiscardFeedTimerVars>({
    mutationKey: ["discardFeedTimer"],
  });
}

/** True while a timer exists only in the optimistic cache: it has no
 *  server id yet, so switch/stop/discard must wait. */
export function isOptimisticTimer(timer: FeedTimer | null | undefined) {
  return !!timer && timer.id === OPTIMISTIC_ID;
}
