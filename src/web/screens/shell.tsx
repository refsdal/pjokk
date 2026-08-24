import { Navigate, Outlet } from "@tanstack/react-router";
import { TabBar } from "@/components/TabBar";
import { useSession } from "@/lib/auth-client";

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

  return (
    <div className="min-h-dvh">
      <Outlet />
      <TabBar />
    </div>
  );
}
