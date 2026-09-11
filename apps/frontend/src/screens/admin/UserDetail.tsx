import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeDevice } from "@/lib/admin-device";
import { ApiError, client, unwrap } from "@/lib/api";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { resetCache } from "@/lib/query";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";
import { AuditRow } from "./Audit";
import type { AdminSession, AdminUserDetail, AuditEntry, Page } from "./lib";
import { LoadMore } from "./LoadMore";
import { Empty, Section } from "./Section";

// One person, in full (spec 2026-09-11-admin-user-support §1) — the page
// every person-scoped support tool hangs off: which families they are in,
// how they sign in, where they are signed in, and what the trail says about
// them.
//
// Metadata only, like the family page: no log entry, no token, no address.
// A session is described by its browser and device (describeDevice), and
// the server never sends anything more.

// Sign out, with the console's tap-twice confirm sized for a row.
function SignOutButton({ onSignOut }: { onSignOut: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={
        armed
          ? "shrink-0 rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-on-accent"
          : "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-danger"
      }
      onClick={() => (armed ? onSignOut() : setArmed(true))}
    >
      {armed ? t("Tap again to confirm") : t("Sign out")}
    </button>
  );
}

function SessionRow({
  session,
  onSignOut,
}: {
  session: AdminSession;
  onSignOut: () => void;
}) {
  const device = describeDevice(
    session.userAgent,
    t("on"),
    t("Unknown device"),
  );
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      data-testid="admin-session"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink">
          {device}
          {session.impersonatedByName && (
            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
              {t("impersonated by")} {session.impersonatedByName}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted">
          {t("started")} {formatRelative(new Date(session.createdAt))} ·{" "}
          {t("active")} {formatRelative(new Date(session.lastActiveAt))}
          {session.familyName ? ` · ${t("in")} ${session.familyName}` : ""}
        </p>
      </div>
      <SignOutButton onSignOut={onSignOut} />
    </div>
  );
}

// The login address, changed. Sessions and a linked Google account stay;
// a 409 names the problem inline rather than in a toast that has gone by
// the time the operator looks for it.
function ChangeEmailSheet({
  user,
  open,
  onOpenChange,
  onChanged,
}: {
  user: AdminUserDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState(user.email);
  const [error, setError] = useState<string | null>(null);
  // A fresh form each time the sheet opens.
  useEffect(() => {
    if (open) {
      setEmail(user.email);
      setError(null);
    }
  }, [open, user.email]);

  const change = useMutation({
    mutationFn: async () =>
      unwrap(
        client.POST("/api/admin/users/{id}/email", {
          params: { path: { id: user.id } },
          body: { email },
        }),
      ),
    onSuccess: () => {
      toast(t("Email changed"));
      onOpenChange(false);
      onChanged();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN")
        setError(t("That address belongs to another account"));
      else if (err instanceof ApiError && err.code === "UNCHANGED")
        setError(t("That is already their address"));
      else setError(err.message);
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Change email")}>
      <div className="space-y-3 pb-4">
        <p className="text-sm text-muted">
          {t(
            "Their sessions and a linked Google account stay. Password sign-in uses the new address from now on.",
          )}
        </p>
        <Input
          type="email"
          aria-label={t("New email")}
          placeholder={t("New email")}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p className="px-1 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button
          size="full"
          disabled={!email.trim() || change.isPending}
          onClick={() => change.mutate()}
        >
          {t("Change email")}
        </Button>
      </div>
    </Sheet>
  );
}

export function AdminUserDetailScreen() {
  const { id } = useParams({ from: "/admin/users/$id" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe();
  const isSelf = me.data?.userId === id;
  const [password, setPassword] = useState("");
  const [changingEmail, setChangingEmail] = useState(false);

  const user = useQuery({
    queryKey: ["admin", "user", id],
    queryFn: async () =>
      unwrap<AdminUserDetail>(
        client.GET("/api/admin/users/{id}", { params: { path: { id } } }),
      ),
  });
  const history = useInfiniteQuery({
    queryKey: ["admin", "audit", "target", id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap<Page<AuditEntry>>(
        client.GET("/api/admin/audit", {
          params: {
            query: {
              target: id,
              limit: 20,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };
  // Every action is audited server-side; this only reports the outcome.
  const run = async (done: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(done);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };

  if (user.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted">{t("Loading…")}</p>
    );
  }
  if (!user.data) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        {t("No such person.")}
      </p>
    );
  }
  const u = user.data;
  const isSystemAdmin = u.role === "admin";
  const entries = history.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <Link
        to="/admin/users"
        className="flex items-center gap-1 text-sm text-muted"
      >
        <IconArrowLeft className="h-4 w-4" />
        {t("All users")}
      </Link>

      <div className="space-y-1 px-1">
        <p className="text-xl font-extrabold text-ink">
          {u.name || u.email}
          {isSystemAdmin && (
            <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 align-middle text-[10px] font-bold text-accent uppercase">
              {t("System admin")}
            </span>
          )}
        </p>
        <p className="text-sm text-muted">
          {u.email} · {t("joined")} {formatRelative(new Date(u.createdAt))}
        </p>
      </div>
      {u.banned && (
        <p className="rounded-2xl bg-danger/15 px-4 py-3 text-sm font-semibold text-danger">
          {t("Banned")}
          {u.banReason ? ` — ${u.banReason}` : ""}
        </p>
      )}

      <Section title={t("Families")}>
        {u.families.length === 0 && <Empty>{t("Not in any family.")}</Empty>}
        {u.families.map((f) => (
          <Link
            key={f.familyId}
            to="/admin/families/$id"
            params={{ id: f.familyId }}
            className="flex items-center justify-between gap-3 px-4 py-3 active:bg-surface-2"
          >
            <span className="truncate font-semibold text-ink">{f.name}</span>
            <span className="text-xs text-muted">
              {f.role === "member" ? t("member") : t("admin")}
            </span>
          </Link>
        ))}
      </Section>

      <Section title={t("Sign-in")}>
        <p className="px-4 py-3 text-sm text-ink">
          {u.hasPassword ? t("Password set") : t("No password")}
        </p>
        {u.providers.map((p) => (
          <p key={p.provider} className="px-4 py-3 text-sm text-ink">
            {p.provider === "google" ? "Google" : p.provider}
            <span className="text-muted">
              {" · "}
              {t("linked")} {formatRelative(new Date(p.linkedAt))}
            </span>
          </p>
        ))}
        <div className="flex gap-2 px-4 py-3">
          <Input
            type="text"
            aria-label={t("New password")}
            placeholder={t("New password (min 8)")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={password.length < 8}
            onClick={() =>
              void run(t("Password set"), async () => {
                await unwrap(
                  client.POST("/api/admin/users/{id}/password", {
                    params: { path: { id } },
                    body: { password },
                  }),
                );
                setPassword("");
              })
            }
          >
            {t("Set")}
          </Button>
        </div>
      </Section>

      <Section
        title={t("Sessions")}
        action={
          u.sessions.length > 0 && (
            <button
              type="button"
              className="text-xs font-semibold text-danger"
              onClick={() =>
                void run(t("Signed out everywhere"), () =>
                  unwrap(
                    client.POST("/api/admin/users/{id}/sessions/revoke", {
                      params: { path: { id } },
                    }),
                  ),
                )
              }
            >
              {t("Sign out everywhere")}
            </button>
          )
        }
      >
        {u.sessions.length === 0 && (
          <Empty>{t("Not signed in anywhere.")}</Empty>
        )}
        {u.sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            onSignOut={() =>
              void run(t("Signed out"), () =>
                unwrap(
                  client.DELETE("/api/admin/users/{id}/sessions/{sessionId}", {
                    params: { path: { id, sessionId: s.id } },
                  }),
                ),
              )
            }
          />
        ))}
      </Section>

      <Section title={t("History")}>
        {history.isSuccess && entries.length === 0 && (
          <Empty>{t("Nothing recorded about this person yet.")}</Empty>
        )}
        {entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} />
        ))}
      </Section>
      <LoadMore
        hasMore={!!history.hasNextPage}
        loading={history.isFetchingNextPage}
        onLoad={() => void history.fetchNextPage()}
      />

      <Section title={t("Support")}>
        <div className="space-y-2 p-4">
          <Button
            size="full"
            variant="outline"
            onClick={() => setChangingEmail(true)}
          >
            {t("Change email")}
          </Button>
          {!isSelf && (
            <>
              {isSystemAdmin && (
                <DeleteButton
                  label={t("Revoke system admin")}
                  onDelete={() =>
                    void run(t("System admin revoked"), () =>
                      unwrap(
                        client.DELETE("/api/admin/users/{id}/role", {
                          params: { path: { id } },
                        }),
                      ),
                    )
                  }
                />
              )}
              <Button
                size="full"
                variant="outline"
                onClick={() =>
                  void run(u.banned ? t("Unbanned") : t("Banned"), () =>
                    u.banned
                      ? unwrap(
                          client.POST("/api/admin/users/{id}/unban", {
                            params: { path: { id } },
                          }),
                        )
                      : unwrap(
                          client.POST("/api/admin/users/{id}/ban", {
                            params: { path: { id } },
                            body: { reason: "banned via admin console" },
                          }),
                        ),
                  )
                }
              >
                {u.banned ? t("Unban") : t("Ban")}
              </Button>
              <Button
                size="full"
                variant="secondary"
                onClick={() =>
                  void run(t("Impersonating"), async () => {
                    await unwrap(
                      client.POST("/api/admin/users/{id}/impersonate", {
                        params: { path: { id } },
                      }),
                    );
                    // The session cookie now belongs to the target; the
                    // persisted cache still holds the operator's own
                    // /api/me, family and members. Drop it before the
                    // reload or the app renders the wrong person.
                    await resetCache();
                    window.location.assign("/home");
                  })
                }
              >
                {t("Impersonate")}
              </Button>
              <DeleteButton
                label={t("Delete account")}
                onDelete={() =>
                  void run(t("User deleted"), async () => {
                    // The server's safe delete: log attribution moves to
                    // the tombstone first, then the account goes.
                    await unwrap(
                      client.POST("/api/admin/users/{id}/delete", {
                        params: { path: { id } },
                      }),
                    );
                    void navigate({ to: "/admin/users" });
                  })
                }
              />
            </>
          )}
        </div>
      </Section>

      <ChangeEmailSheet
        user={u}
        open={changingEmail}
        onOpenChange={setChangingEmail}
        onChanged={refresh}
      />
    </div>
  );
}
