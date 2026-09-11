import { useQuery } from "@tanstack/react-query";
import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { type OpsSummary, opsSummary } from "@/lib/admin-ops";
import { client, unwrap } from "@/lib/api";
import type { components } from "@pjokk/shared";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { jobTitle, useAdminOps } from "./useAdminOps";

type AdminStats = components["schemas"]["AdminStats"];

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="py-3 text-center">
      <p className="text-xl font-extrabold text-ink">{value}</p>
      <p className="text-[11px] font-semibold text-muted uppercase">{label}</p>
    </Card>
  );
}

function summaryText(s: OpsSummary): string {
  switch (s.kind) {
    case "healthy":
      return t("All jobs healthy");
    case "schema-behind":
      return t("The database is behind this build");
    case "schema-ahead":
      return t("The database is ahead of this build");
    case "failed":
      return `${jobTitle(s.job)} ${t("failed")} ${formatRelative(new Date(s.at))}`;
    case "interrupted":
      return `${jobTitle(s.job)} ${t("was interrupted")}`;
    case "never-run":
      return `${jobTitle(s.job)} ${t("has never run")}`;
    case "stale":
      return `${jobTitle(s.job)} ${t("is stale")}`;
  }
}

// One line above the tiles: the first thing on the Ops tab worth a look,
// or that there is nothing to look at (spec 2026-09-11-admin-ops §2).
function OpsStatus() {
  const ops = useAdminOps();
  if (!ops.data) return null;
  const summary = opsSummary(ops.data);
  const healthy = summary.kind === "healthy";
  return (
    <Link
      to="/admin/ops"
      data-testid="ops-summary"
      className={
        healthy
          ? "flex items-center justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-3 text-sm font-semibold text-ink"
          : "flex items-center justify-between gap-3 rounded-2xl bg-danger/15 px-4 py-3 text-sm font-semibold text-danger"
      }
    >
      <span>{summaryText(summary)}</span>
      <IconChevronRight className="h-4 w-4 shrink-0" />
    </Link>
  );
}

export function AdminOverview() {
  const stats = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: async () => unwrap<AdminStats>(client.GET("/api/admin/stats")),
  });
  const s = stats.data;

  return (
    <div className="space-y-2">
      <OpsStatus />
      {s ? (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="families" value={s.families} />
          <StatTile label="users" value={s.users} />
          <StatTile label="babies" value={s.babies} />
          <StatTile label="core logs" value={s.coreLogs} />
          <StatTile label="push subs" value={s.pushSubscriptions} />
          <StatTile label="users 7d" value={s.usersLast7d} />
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      )}
    </div>
  );
}
