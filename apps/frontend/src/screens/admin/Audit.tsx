import { useInfiniteQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import type { AuditEntry, Page } from "./lib";
import { LoadMore } from "./LoadMore";

// The append-only trail, newest first, a page at a time. The user page
// shows the same rows narrowed to one person (UserDetail.tsx's History).
export function AdminAudit() {
  const auditLog = useInfiniteQuery({
    queryKey: ["admin", "audit"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap<Page<AuditEntry>>(
        client.GET("/api/admin/audit", {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = auditLog.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-2">
      <Card className="divide-y divide-line p-0">
        {auditLog.isSuccess && rows.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted">
            {t("No admin actions yet.")}
          </p>
        )}
        {rows.map((entry) => (
          <AuditRow key={entry.id} entry={entry} />
        ))}
      </Card>
      <LoadMore
        hasMore={!!auditLog.hasNextPage}
        loading={auditLog.isFetchingNextPage}
        onLoad={() => void auditLog.fetchNextPage()}
      />
    </div>
  );
}

export function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <div className="px-4 py-2.5">
      <p className="text-sm text-ink">
        <span className="font-semibold">{entry.adminName}</span>{" "}
        <span className="font-mono text-xs">{entry.action}</span>
        {entry.detail ? ` — ${entry.detail}` : ""}
      </p>
      <p className="text-[11px] text-muted">
        {formatRelative(new Date(entry.createdAt))} · {entry.target}
      </p>
    </div>
  );
}
