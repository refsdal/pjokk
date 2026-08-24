import { Link, useRouterState } from "@tanstack/react-router";
import { ChartColumn, House, List, Settings } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/", label: "Home", icon: House },
  { to: "/timeline", label: "Timeline", icon: List },
  { to: "/stats", label: "Stats", icon: ChartColumn },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur">
      <div className="mx-auto flex max-w-md">
        {tabs.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold",
                active ? "text-accent" : "text-muted",
              )}
            >
              <Icon className="h-6 w-6" strokeWidth={active ? 2.4 : 2} />
              {t(label)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
