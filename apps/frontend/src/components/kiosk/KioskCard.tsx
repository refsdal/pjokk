import type { Icon as TablerIcon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// One activity card (spec §4): icon + label, the elapsed time at 48 px, a
// detail line, a totals sub-line, the quick actions. `tone` caution = the
// reminder interval has elapsed; live = a session or timer is running.
export function KioskCard({
  icon: Icon,
  tint,
  label,
  headline,
  detail,
  sub,
  tone = "normal",
  children,
  testId,
}: {
  icon: TablerIcon;
  tint: string;
  label: string;
  headline: string;
  detail: string;
  sub?: string | null;
  tone?: "normal" | "caution" | "live";
  children: ReactNode;
  testId: string;
}) {
  const caution = tone === "caution";
  return (
    <section
      data-testid={testId}
      data-tone={tone}
      className={cn(
        "flex min-h-[280px] flex-col gap-4 rounded-3xl border bg-surface p-5",
        caution ? "border-caution" : "border-line",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2",
            caution ? "text-caution" : tint,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold tracking-[.08em] text-muted uppercase">
          {label}
        </span>
        {tone === "live" && (
          <span className="ml-auto rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-extrabold tracking-wider text-on-accent uppercase">
            {t("live")}
          </span>
        )}
      </div>
      <div className="space-y-1">
        <p
          className={cn(
            "text-5xl font-extrabold tracking-tight tabular-nums",
            caution
              ? "text-caution"
              : tone === "live"
                ? "text-accent"
                : "text-ink",
          )}
        >
          {headline}
        </p>
        <p className="text-[17px] font-medium text-ink-soft">{detail}</p>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      <div className="flex-1" />
      <div className="flex gap-2">{children}</div>
    </section>
  );
}
