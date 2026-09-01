import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client, unwrap } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { toast } from "@/lib/toast";
import type { AdminUser } from "./lib";

function UserSheet({
  user,
  onClose,
  refresh,
}: {
  user: AdminUser | null;
  onClose: () => void;
  refresh: () => void;
}) {
  const [password, setPassword] = useState("");
  const { data: session } = useSession();
  const isSelf = user?.id === session?.user.id;

  // Auditing happens server-side for every admin op (issue #6).
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(`${label} ✓`);
      refresh();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : `${label} failed`, "error");
    }
  };

  return (
    <Sheet
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      title={user?.name ?? ""}
    >
      {user && (
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted">
            {user.email}
            {user.role === "admin" && " · system admin"}
            {user.banned && " · BANNED"}
          </p>

          <Button
            size="full"
            variant="outline"
            onClick={() =>
              void run("Sessions revoked", () =>
                authClient.admin.revokeUserSessions({ userId: user.id }),
              )
            }
          >
            Revoke all sessions
          </Button>

          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="New password (min 8)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={password.length < 8}
              onClick={() =>
                void run("Password set", () =>
                  authClient.admin.setUserPassword({
                    userId: user.id,
                    newPassword: password,
                  }),
                )
              }
            >
              Set
            </Button>
          </div>

          {!isSelf && (
            <>
              <Button
                size="full"
                variant="outline"
                onClick={() =>
                  void run(user.banned ? "Unbanned" : "Banned", () =>
                    user.banned
                      ? authClient.admin.unbanUser({ userId: user.id })
                      : authClient.admin.banUser({
                          userId: user.id,
                          banReason: "banned via admin console",
                        }),
                  )
                }
              >
                {user.banned ? "Unban" : "Ban"}
              </Button>

              <Button
                size="full"
                variant="secondary"
                onClick={() =>
                  void run("Impersonating", async () => {
                    await authClient.admin.impersonateUser({
                      userId: user.id,
                    });
                    window.location.assign("/home");
                  })
                }
              >
                Impersonate
              </Button>

              <DeleteButton
                onDelete={() =>
                  void run(
                    "User deleted",
                    // Server-side safe delete: reassigns log attribution to
                    // the tombstone first, audits, then removes the account.
                    async () =>
                      unwrap(
                        client.POST("/api/admin/users/{id}/delete", {
                          params: { path: { id: user.id } },
                        }),
                      ),
                  )
                }
              />
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function AdminUsers() {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await authClient.admin.listUsers({
        query: { limit: 200, sortBy: "createdAt", sortDirection: "desc" },
      });
      if (res.error) throw new Error(res.error.message);
      return res.data.users as AdminUser[];
    },
  });

  return (
    <>
      <Card className="divide-y divide-line p-0">
        {(users.data ?? []).map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => setSelectedUser(u)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {u.name}
                {u.role === "admin" && (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
                    admin
                  </span>
                )}
                {u.banned && (
                  <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger uppercase">
                    banned
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted">{u.email}</p>
            </div>
          </button>
        ))}
      </Card>

      <UserSheet
        user={selectedUser}
        onClose={() => setSelectedUser(null)}
        refresh={() =>
          void queryClient.invalidateQueries({ queryKey: ["admin"] })
        }
      />
    </>
  );
}
