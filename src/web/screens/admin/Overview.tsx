import { useQuery } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { AdminStatsSchema } from "@pjokk/shared";
import { Card } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";

type AdminStats = z.infer<typeof AdminStatsSchema>;

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="py-3 text-center">
      <p className="text-xl font-extrabold text-ink">{value}</p>
      <p className="text-[11px] font-semibold text-muted uppercase">{label}</p>
    </Card>
  );
}

export function AdminOverview() {
  const stats = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: async () => unwrap<AdminStats>(await api.admin.stats.$get()),
  });
  const s = stats.data;

  return (
    <div className="space-y-2">
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
      <p className="pt-4 text-center text-xs text-muted">
        Billing metrics arrive with the Stripe phase.
      </p>
    </div>
  );
}
