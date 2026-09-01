import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { client, unwrap } from "@/lib/api";
import type { components } from "@/lib/api-schema";
import { formatRelative } from "@/lib/time";

type AuditEntry = components["schemas"]["AuditEntry"];

export function AdminAudit() {
  const auditLog = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: async () => unwrap<AuditEntry[]>(client.GET("/api/admin/audit")),
  });

  return (
    <Card className="divide-y divide-line p-0">
      {(auditLog.data ?? []).length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-muted">
          No admin actions yet.
        </p>
      )}
      {(auditLog.data ?? []).map((entry) => (
        <div key={entry.id} className="px-4 py-2.5">
          <p className="text-sm text-ink">
            <span className="font-semibold">{entry.adminName}</span>{" "}
            <span className="font-mono text-xs">{entry.action}</span>
            {entry.detail ? ` — ${entry.detail}` : ""}
          </p>
          <p className="text-[11px] text-muted">
            {formatRelative(new Date(entry.createdAt))} · {entry.target}
          </p>
        </div>
      ))}
    </Card>
  );
}
