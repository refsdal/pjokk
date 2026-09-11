import { useInfiniteQuery } from "@tanstack/react-query";
import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useDebounced } from "@/lib/use-debounced";
import type { AdminUser, Page } from "./lib";
import { LoadMore } from "./LoadMore";

// The operator's user list: a server-side search (name or email) and a page
// at a time. A row opens the user page (UserDetail.tsx), where every support
// tool for a person lives.
export function AdminUsers() {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const users = useInfiniteQuery({
    queryKey: ["admin", "users", q],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap<Page<AdminUser>>(
        client.GET("/api/admin/users", {
          params: {
            query: {
              ...(q ? { query: q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = users.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-2">
      <Input
        type="search"
        placeholder={t("Search users")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Card className="divide-y divide-line p-0">
        {rows.map((u) => (
          <Link
            key={u.id}
            to="/admin/users/$id"
            params={{ id: u.id }}
            className="flex items-center gap-3 px-4 py-3 active:bg-surface-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {u.name || u.email}
                {u.role === "admin" && (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
                    {t("admin")}
                  </span>
                )}
                {u.banned && (
                  <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger uppercase">
                    {t("banned")}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted">{u.email}</p>
            </div>
            <IconChevronRight className="h-5 w-5 shrink-0 text-muted" />
          </Link>
        ))}
        {users.isSuccess && rows.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted">
            {q ? t("No users match.") : t("No users yet.")}
          </p>
        )}
      </Card>
      <LoadMore
        hasMore={!!users.hasNextPage}
        loading={users.isFetchingNextPage}
        onLoad={() => void users.fetchNextPage()}
      />
    </div>
  );
}
