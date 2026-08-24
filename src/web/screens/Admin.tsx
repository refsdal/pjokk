import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import { IconArrowLeft, IconShieldCog } from "@tabler/icons-react";
import { useState } from "react";
import type { z } from "@hono/zod-openapi";
import type {
  AdminFamilySchema,
  AdminStatsSchema,
  AuditEntrySchema,
} from "@shared/schemas";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, unwrap } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";

type AdminStats = z.infer<typeof AdminStatsSchema>;
type AdminFamily = z.infer<typeof AdminFamilySchema>;
type AuditEntry = z.infer<typeof AuditEntrySchema>;

// Operator console — deliberately English-only and desktop-tolerant.
// User-support ops go through better-auth's admin API; everything is audited.

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
};

function note(action: string, target: string, detail?: string) {
  void api.admin.audit.$post({ json: { action, target, detail } });
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1 pt-6 pb-2 text-xs font-bold tracking-wider text-muted uppercase">
      {children}
    </h2>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="flex-1 py-3 text-center">
      <p className="text-xl font-extrabold text-ink">{value}</p>
      <p className="text-[11px] font-semibold text-muted uppercase">{label}</p>
    </Card>
  );
}

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

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    auditAction: string,
  ) => {
    try {
      await fn();
      note(auditAction, user!.id, user!.email);
      toast(`${label} ✓`);
      refresh();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : `${label} failed`, "error");
    }
  };

  return (
    <Sheet open={!!user} onOpenChange={(o) => !o && onClose()} title={user?.name ?? ""}>
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
              void run(
                "Sessions revoked",
                () => authClient.admin.revokeUserSessions({ userId: user.id }),
                "user.revoke-sessions",
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
                void run(
                  "Password set",
                  () =>
                    authClient.admin.setUserPassword({
                      userId: user.id,
                      newPassword: password,
                    }),
                  "user.set-password",
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
                  void run(
                    user.banned ? "Unbanned" : "Banned",
                    () =>
                      user.banned
                        ? authClient.admin.unbanUser({ userId: user.id })
                        : authClient.admin.banUser({
                            userId: user.id,
                            banReason: "banned via admin console",
                          }),
                    user.banned ? "user.unban" : "user.ban",
                  )
                }
              >
                {user.banned ? "Unban" : "Ban"}
              </Button>

              <Button
                size="full"
                variant="secondary"
                onClick={() =>
                  void run(
                    "Impersonating",
                    async () => {
                      await authClient.admin.impersonateUser({
                        userId: user.id,
                      });
                      window.location.assign("/");
                    },
                    "user.impersonate",
                  )
                }
              >
                Impersonate
              </Button>

              <DeleteButton
                onDelete={() =>
                  void run(
                    "User deleted",
                    () => authClient.admin.removeUser({ userId: user.id }),
                    "user.delete",
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

export function AdminScreen() {
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);

  const isSysadmin =
    (session?.user as { role?: string | null } | undefined)?.role === "admin";

  const stats = useQuery({
    queryKey: ["admin", "stats"],
    enabled: isSysadmin,
    queryFn: async () => unwrap<AdminStats>(await api.admin.stats.$get()),
  });

  const families = useQuery({
    queryKey: ["admin", "families"],
    enabled: isSysadmin,
    queryFn: async () =>
      unwrap<AdminFamily[]>(await api.admin.families.$get()),
  });

  const users = useQuery({
    queryKey: ["admin", "users"],
    enabled: isSysadmin,
    queryFn: async () => {
      const res = await authClient.admin.listUsers({
        query: { limit: 200, sortBy: "createdAt", sortDirection: "desc" },
      });
      if (res.error) throw new Error(res.error.message);
      return res.data.users as AdminUser[];
    },
  });

  const auditLog = useQuery({
    queryKey: ["admin", "audit"],
    enabled: isSysadmin,
    queryFn: async () => unwrap<AuditEntry[]>(await api.admin.audit.$get()),
  });

  const deleteFamily = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.admin.families[":id"].$delete({ param: { id } })),
    onSuccess: () => {
      toast("Family deleted");
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  if (isPending) return <div className="min-h-dvh" />;
  if (!session) return <Navigate to="/login" />;
  if (!isSysadmin) return <Navigate to="/" />;

  const refreshUsers = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin"] });

  return (
    <div className="mx-auto max-w-xl px-4 pt-safe pb-safe">
      <header className="flex items-center gap-3 py-4">
        <Link to="/settings" className="text-muted">
          <IconArrowLeft className="h-6 w-6" />
        </Link>
        <IconShieldCog className="h-6 w-6 text-accent" />
        <h1 className="text-2xl font-extrabold text-ink">Admin</h1>
      </header>

      {stats.data && (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="families" value={stats.data.families} />
          <StatTile label="users" value={stats.data.users} />
          <StatTile label="babies" value={stats.data.babies} />
          <StatTile label="core logs" value={stats.data.coreLogs} />
          <StatTile label="push subs" value={stats.data.pushSubscriptions} />
          <StatTile label="users 7d" value={stats.data.usersLast7d} />
        </div>
      )}

      <SectionTitle>Families</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {(families.data ?? []).map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {f.name}
                <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
                  {f.plan}
                </span>
              </p>
              <p className="text-xs text-muted">
                {f.members} members · {f.babies} babies ·{" "}
                {f.lastFeedAt
                  ? `last feed ${formatRelative(new Date(f.lastFeedAt))}`
                  : "no feeds"}
              </p>
            </div>
            <div className="w-28 shrink-0">
              <DeleteButton onDelete={() => deleteFamily.mutate(f.id)} />
            </div>
          </div>
        ))}
      </Card>

      <SectionTitle>Users</SectionTitle>
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

      <SectionTitle>Audit trail</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {(auditLog.data ?? []).length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">No admin actions yet.</p>
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

      <UserSheet
        user={selectedUser}
        onClose={() => setSelectedUser(null)}
        refresh={refreshUsers}
      />
    </div>
  );
}
