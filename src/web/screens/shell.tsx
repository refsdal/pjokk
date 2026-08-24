import { Navigate, Outlet } from "@tanstack/react-router";
import { TabBar } from "@/components/TabBar";
import { authClient, useSession } from "@/lib/auth-client";

// Authed shell: session required; users without a family go to /welcome
// (the invite flow normally prevents that, but the family founder starts
// here). Appearance (theme + night mode) is provided at the router root.
export function AppShell() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <div className="min-h-dvh" />;
  }
  if (!session) {
    return <Navigate to="/login" />;
  }
  if (!session.session.activeOrganizationId) {
    return <Navigate to="/welcome" />;
  }

  const impersonatedBy = (
    session.session as { impersonatedBy?: string | null }
  ).impersonatedBy;

  return (
    <div className="min-h-dvh">
      {impersonatedBy && (
        <div className="flex items-center justify-between gap-3 bg-danger px-4 py-2 pt-safe text-sm font-semibold text-white">
          <span>Impersonating {session.user.name}</span>
          <button
            type="button"
            className="rounded-full bg-white/20 px-3 py-1"
            onClick={() =>
              void authClient.admin
                .stopImpersonating()
                .then(() => window.location.assign("/admin"))
            }
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
