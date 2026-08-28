import { Link, useRouterState } from "@tanstack/react-router";
import {
  IconCalendar,
  IconChartBar,
  IconHome,
  IconList,
  IconLock,
  IconSettings,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { usePremium } from "@/lib/data";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface TabItem {
  to: string;
  label: string;
  icon: TablerIcon;
  // Exact-match tabs (section roots like "/home" or "/admin") only highlight
  // on their own path; others highlight for their whole subtree.
  exact?: boolean;
  // Premium-gated tab: shows a small lock badge for free-tier families.
  // Existing data on the tab stays fully usable — this is a visual nudge,
  // not an access block (the API is the actual gate).
  gated?: boolean;
}

const mainTabs: TabItem[] = [
  { to: "/home", label: "Home", icon: IconHome, exact: true },
  { to: "/timeline", label: "Timeline", icon: IconList },
  { to: "/calendar", label: "Calendar", icon: IconCalendar, gated: true },
  { to: "/stats", label: "Stats", icon: IconChartBar },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function TabBar({ tabs = mainTabs }: { tabs?: TabItem[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const premium = usePremium();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur">
      <div className="mx-auto flex max-w-md">
        {tabs.map(({ to, label, icon: Icon, exact, gated }) => {
          const active = exact
            ? pathname === to || pathname === `${to}/`
            : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold",
                active ? "text-accent" : "text-muted",
              )}
            >
              <span className="relative">
                <Icon className="h-6 w-6" stroke={active ? 2.4 : 2} />
                {gated && !premium && (
                  <IconLock
                    className="absolute -right-1 -top-1 h-3 w-3 text-muted"
                    stroke={2.4}
                  />
                )}
              </span>
              {t(label)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
