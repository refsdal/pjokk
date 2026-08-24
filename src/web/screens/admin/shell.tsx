import { Link, Navigate, Outlet } from "@tanstack/react-router";
import {
  IconArrowLeft,
  IconHistory,
  IconLayoutDashboard,
  IconShieldCog,
  IconUser,
  IconUsersGroup,
} from "@tabler/icons-react";
import { TabBar, type TabItem } from "@/components/TabBar";
import { useSession } from "@/lib/auth-client";

// Operator console shell: role guard + its own bottom tab bar (same
// component as the app's), so each concern gets a page that can grow.

const adminTabs: TabItem[] = [
  { to: "/admin", label: "Overview", icon: IconLayoutDashboard, exact: true },
  { to: "/admin/families", label: "Families", icon: IconUsersGroup },
  { to: "/admin/users", label: "Users", icon: IconUser },
  { to: "/admin/audit", label: "Audit", icon: IconHistory },
];

export function AdminShell() {
  const { data: session, isPending } = useSession();
  if (isPending) return <div className="min-h-dvh" />;
  if (!session) return <Navigate to="/login" />;
  const role = (session.user as { role?: string | null }).role;
  if (role !== "admin") return <Navigate to="/" />;

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-xl px-4 pt-safe">
        <header className="flex items-center gap-3 py-4">
          <Link to="/settings" className="text-muted" title="Back to app">
            <IconArrowLeft className="h-6 w-6" />
          </Link>
          <IconShieldCog className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-extrabold text-ink">Admin</h1>
        </header>
        <div className="pb-tabbar">
          <Outlet />
        </div>
      </div>
      <TabBar tabs={adminTabs} />
    </div>
  );
}
