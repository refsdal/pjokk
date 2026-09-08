import { Link, useRouterState } from "@tanstack/react-router";
import {
  IconCalendar,
  IconChartBar,
  IconHome,
  IconList,
  IconSettings,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

export interface TabItem {
  to: string;
  label: string;
  icon: TablerIcon;
  // Exact-match tabs (section roots like "/home" or "/admin") only highlight
  // on their own path; others highlight for their whole subtree.
  exact?: boolean;
}

const mainTabs: TabItem[] = [
  { to: "/home", label: "Home", icon: IconHome, exact: true },
  { to: "/timeline", label: "Timeline", icon: IconList },
  { to: "/calendar", label: "Calendar", icon: IconCalendar },
  { to: "/stats", label: "Stats", icon: IconChartBar },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function TabBar({ tabs = mainTabs }: { tabs?: TabItem[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    // Compact: the fixed bottom bar. md and up: the SAME nav becomes a fixed
    // 88 px left rail (spec §2) — pure CSS, no second markup path, so the
    // admin shell's own tab list gets the rail for free.
    <nav
      aria-label={t("Main")}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur md:inset-x-auto md:top-0 md:bottom-0 md:left-0 md:w-22 md:border-t-0 md:border-r md:pt-4 md:pb-0"
    >
      <div className="mx-auto flex max-w-md md:mx-0 md:max-w-none md:flex-col">
        {tabs.map(({ to, label, icon: Icon, exact }) => {
          const active = exact
            ? pathname === to || pathname === `${to}/`
            : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold md:h-18 md:w-22 md:flex-none",
                focusRing,
                active ? "text-accent" : "text-muted",
              )}
            >
              <Icon className="h-6 w-6" stroke={active ? 2.4 : 2} />
              {t(label)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
