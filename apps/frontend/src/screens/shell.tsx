import { Navigate, Outlet } from "@tanstack/react-router";
import { TabBar } from "@/components/TabBar";
import { client, unwrap } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useMe } from "@/lib/data";
import { resetCache } from "@/lib/query";
import { toast } from "@/lib/toast";

// Authed shell: session required; users without a family go to /welcome
// (the invite flow normally prevents that, but the family founder starts
// here). Appearance (theme + night mode) is provided at the router root.
//
// Two sources, deliberately: the Limen session store answers "is there a
// session at all", and GET /api/me answers everything about it — the active
// family and the impersonation banner included. Limen's own session payload
// has neither.
export function AppShell() {
  const { data: session, isPending } = useSession();
  const me = useMe();

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
      <Outlet />
      <TabBar />
    </div>
  );
}
