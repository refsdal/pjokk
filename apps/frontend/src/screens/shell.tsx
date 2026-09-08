import { useEffect } from "react";
import { Navigate, Outlet } from "@tanstack/react-router";
import { TabBar } from "@/components/TabBar";
import { client, unwrap } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useAppBadge } from "@/lib/badge";
import { useMe, useSummary } from "@/lib/data";
import {
  judgeFamily,
  readFence,
  recordDiscarded,
  takeDiscarded,
  writeFence,
} from "@/lib/family-fence";
import { t } from "@/lib/i18n";
import { queryClient, resetCache } from "@/lib/query";
import { useSelectedBaby } from "@/lib/selected-baby";
import { toast } from "@/lib/toast";

// Authed shell: session required; users without a family go to /welcome
// (the invite flow normally prevents that, but the family founder starts
// here). Appearance (theme + night mode) is provided at the router root.
//
// Two sources, deliberately: the Limen session store answers "is there a
// session at all", and GET /api/me answers everything about it — the active
// family and the impersonation banner included. Limen's own session payload
// has neither.
// Mounted only once the shell has a family: the selected baby's running
// sleep / play / nursing / pump session puts a dot on the installed icon
// (lib/badge.ts), and unmounting — sign-out, no family — clears it.
function AppBadge() {
  const { baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const s = summary.data;
  useAppBadge(
    !!s && !!(s.activeSleep || s.activePlay || s.activeFeed || s.activePump),
  );
  return null;
}

export function AppShell() {
  const { data: session, isPending } = useSession();
  const me = useMe();

  const familyId = me.data?.familyId ?? null;
  // Family fence (lib/family-fence.ts): a mismatch means the family behind
  // this session changed outside this tab's switch flow.
  useEffect(() => {
    const verdict = judgeFamily(readFence(), familyId);
    if (verdict === "recorded") writeFence(familyId as string);
    if (verdict === "changed") {
      // The server has already switched families by the time this device
      // notices, so any mutation still paused (queued offline) for the OLD
      // family can never be replayed against the new one. resetCache() must
      // still run — the alternative is serving the wrong family's cache —
      // but count what it is about to discard first, so the toast below (a
      // separate effect, fired once after the reload) can tell the person
      // rather than silently dropping their entry.
      const discarded = queryClient
        .getMutationCache()
        .getAll()
        .filter((m) => m.state.isPaused).length;
      recordDiscarded(discarded);
      void resetCache().then(() => window.location.reload());
    }
  }, [familyId]);

  useEffect(() => {
    const n = takeDiscarded();
    if (n > 0) {
      toast(
        t("Unsynced entries were discarded because the family changed"),
        "error",
      );
    }
  }, []);

  // me refetches on every mount (see useMe) — wait for THAT fetch to settle
  // before trusting familyId, so a reload never routes on the persisted
  // pre-family snapshot. isFetchedAfterMount flips true once the mount-fetch
  // resolves (offline: it settles as an error and the persisted value
  // stands, which is the offline-first contract).
  if (isPending || me.isPending || !me.isFetchedAfterMount) {
    return <div className="min-h-dvh" />;
  }
  if (!session) {
    return <Navigate to="/login" />;
  }
  if (!me.data?.familyId) {
    return <Navigate to="/welcome" />;
  }

  const { impersonatedBy, name } = me.data;

  // The impersonated session IS the target user's, so ending it is a
  // session-level route rather than a system-admin one — and the cache has to
  // go with it, or the reload would restore the impersonated user's `me` and
  // bounce the operator straight back out of /admin.
  const stopImpersonating = async () => {
    try {
      await unwrap(client.POST("/api/admin/stop-impersonating"));
      await resetCache();
      window.location.assign("/admin");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Could not stop impersonating",
        "error",
      );
    }
  };

  return (
    <div className="min-h-dvh">
      {impersonatedBy && (
        <div className="flex items-center justify-between gap-3 bg-danger px-4 py-2 pt-safe text-sm font-semibold text-white">
          <span>Impersonating {name}</span>
          <button
            type="button"
            className="rounded-full bg-white/20 px-3 py-1"
            onClick={() => void stopImpersonating()}
          >
            Stop
          </button>
        </div>
      )}
      <AppBadge />
      {/* md and up: clear the 88 px rail and cap the content at 1400 px
          (spec §1–2). Screens keep their own max-w inside this. */}
      <div className="md:pl-22">
        <div className="mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </div>
      <TabBar />
    </div>
  );
}
