import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowLeft, IconCheck, IconPencil } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { InviteQR } from "@/components/InviteQR";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { client, unwrap } from "@/lib/api";
import { t } from "@/lib/i18n";
import { formatRelative } from "@/lib/time";
import { toast } from "@/lib/toast";
import {
  type AdminFamilyDetail,
  type AdminFamilyMember,
  type AdminInvite,
  FAMILY_ROLES,
  type FamilyRole,
  inviteState,
  isPrivilegedRole,
  wouldStrandFamily,
} from "./lib";
import { Empty, Section } from "./Section";

// One family, in full — the page every other family-scoped operator tool
// hangs off.
//
// Metadata only, deliberately: members, babies, invites and keys, and not a
// single log entry or count derived from one. Impersonation stays the only
// route to a family's actual data, and it is audited and shows the family a
// banner. See internal/api/admin_families.go's header for the whole
// argument; adding a log view here means adding a clause to the privacy
// policy first.

// Rename, inline. The slug is deliberately NOT editable and NOT regenerated
// — it is an identifier something may already hold.
function FamilyHeader({
  detail,
  onRenamed,
}: {
  detail: AdminFamilyDetail;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.name);

  const rename = useMutation({
    mutationFn: async () =>
      unwrap(
        client.PATCH("/api/admin/families/{id}", {
          params: { path: { id: detail.id } },
          body: { name },
        }),
      ),
    onSuccess: () => {
      toast(t("Family renamed"));
      setEditing(false);
      onRenamed();
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Card className="space-y-1">
      {editing ? (
        <div className="flex gap-2">
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="secondary"
            aria-label={t("Save name")}
            disabled={!name.trim() || rename.isPending}
            onClick={() => rename.mutate()}
          >
            <IconCheck className="h-5 w-5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-xl font-extrabold text-ink">
            {detail.name}
          </h1>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
            {detail.plan}
          </span>
          <button
            type="button"
            aria-label={t("Rename family")}
            onClick={() => {
              setName(detail.name);
              setEditing(true);
            }}
          >
            <IconPencil className="h-5 w-5 text-muted" />
          </button>
        </div>
      )}
      <p className="font-mono text-xs text-muted">{detail.slug}</p>
      <p className="text-xs text-muted">
        {t("Created")} {formatRelative(new Date(detail.createdAt))} ·{" "}
        {detail.lastFeedAt
          ? `${t("last feed")} ${formatRelative(new Date(detail.lastFeedAt))}`
          : t("no feeds")}
      </p>
    </Card>
  );
}

function MemberSheet({
  detail,
  member,
  onClose,
  refresh,
}: {
  detail: AdminFamilyDetail;
  member: AdminFamilyMember | null;
  onClose: () => void;
  refresh: () => void;
}) {
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

  const isAdmin = member ? isPrivilegedRole(member.role) : false;
  const nextRole = isAdmin ? "member" : "admin";
  // Disabled rather than hidden: the operator should see that the control
  // exists and why it will not work. The server refuses regardless.
  const lastAdmin = member
    ? wouldStrandFamily(detail.members, member, isAdmin ? "member" : "admin")
    : false;

  return (
    <Sheet
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={member?.name || member?.email || ""}
    >
      {member && (
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted">
            {member.email} · {member.role}
            {member.banned && " · BANNED"}
          </p>

          <Button
            size="full"
            variant="outline"
            disabled={lastAdmin}
            onClick={() =>
              void run(t("Role changed"), () =>
                unwrap(
                  client.POST(
                    "/api/admin/families/{id}/members/{memberId}/role",
                    {
                      params: {
                        path: { id: detail.id, memberId: member.memberId },
                      },
                      body: { role: nextRole },
                    },
                  ),
                ),
              )
            }
          >
            {isAdmin ? t("Make member") : t("Make admin")}
          </Button>

          {lastAdmin && (
            <p className="text-xs text-muted">
              {t(
                "This is the family's last admin. Promote someone else before changing or removing them.",
              )}
            </p>
          )}

          <DeleteButton
            label={t("Remove from family")}
            disabled={lastAdmin}
            onDelete={() =>
              void run(t("Removed"), () =>
                unwrap(
                  client.DELETE("/api/admin/families/{id}/members/{memberId}", {
                    params: {
                      path: { id: detail.id, memberId: member.memberId },
                    },
                  }),
                ),
              )
            }
          />
        </div>
      )}
    </Sheet>
  );
}

function AddMemberSheet({
  familyId,
  open,
  onOpenChange,
  refresh,
}: {
  familyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        client.POST("/api/admin/families/{id}/members", {
          params: { path: { id: familyId } },
          body: { email, role },
        }),
      ),
    onSuccess: () => {
      toast(t("Member added"));
      setEmail("");
      refresh();
      onOpenChange(false);
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Add member")}>
      <div className="space-y-3 pb-4">
        <Input
          type="email"
          placeholder={t("Their email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="px-1 text-xs text-muted">
          {t(
            "The account must already exist — this never creates one. Use an invite link for someone new.",
          )}
        </p>
        <div className="flex gap-2">
          {(["member", "admin"] as const).map((r) => (
            <Button
              key={r}
              variant={role === r ? "secondary" : "outline"}
              onClick={() => setRole(r)}
            >
              {r === "admin" ? t("Admin") : t("Member")}
            </Button>
          ))}
        </div>
        <Button
          size="full"
          disabled={!email.trim() || add.isPending}
          onClick={() => add.mutate()}
        >
          {t("Add to family")}
        </Button>
      </div>
    </Sheet>
  );
}

export function AdminFamilyDetailScreen() {
  const { id } = useParams({ from: "/admin/families/$id" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<AdminFamilyMember | null>(null);
  const [adding, setAdding] = useState(false);
  const [minting, setMinting] = useState(false);
  const [shownInvite, setShownInvite] = useState<AdminInvite | null>(null);

  const family = useQuery({
    queryKey: ["admin", "family", id],
    queryFn: async () =>
      unwrap<AdminFamilyDetail>(
        client.GET("/api/admin/families/{id}", { params: { path: { id } } }),
      ),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
  };

  // The defaults are spelled out because openapi-typescript types a field
  // with a `default:` as REQUIRED on the request — Settings → Family does
  // the same for the family-admin route. The server's shared core applies
  // the identical values when a field is absent.
  const mintInvite = useMutation({
    mutationFn: async (role: FamilyRole) =>
      unwrap<AdminInvite>(
        client.POST("/api/admin/families/{id}/invites", {
          params: { path: { id } },
          body: { role, expiresInHours: 72, maxUses: 5 },
        }),
      ),
    onSuccess: (invite) => {
      setMinting(false);
      setShownInvite(invite);
      refresh();
    },
    onError: (err) => toast(err.message, "error"),
  });

  const revokeInvite = useMutation({
    mutationFn: async (code: string) =>
      unwrap(
        client.DELETE("/api/admin/families/{id}/invites/{code}", {
          params: { path: { id, code } },
        }),
      ),
    onSuccess: () => {
      toast(t("Invite revoked"));
      refresh();
    },
    onError: (err) => toast(err.message, "error"),
  });

  const revokeKey = useMutation({
    mutationFn: async (keyId: string) =>
      unwrap(
        client.DELETE("/api/admin/families/{id}/keys/{keyId}", {
          params: { path: { id, keyId } },
        }),
      ),
    onSuccess: () => {
      toast(t("Key revoked"));
      refresh();
    },
    onError: (err) => toast(err.message, "error"),
  });

  const deleteFamily = useMutation({
    mutationFn: async () =>
      unwrap(
        client.DELETE("/api/admin/families/{id}", {
          params: { path: { id } },
        }),
      ),
    onSuccess: () => {
      toast(t("Family deleted"));
      refresh();
      void navigate({ to: "/admin/families" });
    },
    onError: (err) => toast(err.message, "error"),
  });

  if (family.isPending) {
    return (
      <p className="py-10 text-center text-sm text-muted">{t("Loading…")}</p>
    );
  }
  if (!family.data) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        {t("No such family.")}
      </p>
    );
  }
  const detail = family.data;

  return (
    <div className="space-y-4">
      <Link
        to="/admin/families"
        className="flex items-center gap-1 text-sm text-muted"
      >
        <IconArrowLeft className="h-4 w-4" />
        {t("All families")}
      </Link>

      <FamilyHeader detail={detail} onRenamed={refresh} />

      <Section
        title={t("Members")}
        action={
          <button
            type="button"
            className="text-xs font-semibold text-accent"
            onClick={() => setAdding(true)}
          >
            {t("Add")}
          </button>
        }
      >
        {detail.members.length === 0 && (
          <Empty>
            {t("Nobody is in this family. Send an invite link below.")}
          </Empty>
        )}
        {detail.members.map((m) => (
          <button
            key={m.memberId}
            type="button"
            onClick={() => setSelected(m)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {m.name || m.email}
                {isPrivilegedRole(m.role) && (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent uppercase">
                    {m.role}
                  </span>
                )}
                {m.banned && (
                  <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger uppercase">
                    {t("banned")}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted">
                {m.email} · {t("joined")} {formatRelative(new Date(m.joinedAt))}
              </p>
            </div>
          </button>
        ))}
      </Section>

      <Section title={t("Babies")}>
        {detail.babies.length === 0 && <Empty>{t("No babies yet.")}</Empty>}
        {detail.babies.map((b) => (
          <div key={b.id} className="px-4 py-3">
            <p className="font-semibold text-ink">{b.name}</p>
            <p className="text-xs text-muted">
              {new Date(b.birthDate).toLocaleDateString()}
              {b.sex ? ` · ${b.sex}` : ""}
            </p>
          </div>
        ))}
      </Section>

      <Section
        title={t("Invites")}
        action={
          <button
            type="button"
            className="text-xs font-semibold text-accent"
            onClick={() => setMinting(true)}
          >
            {t("Mint")}
          </button>
        }
      >
        {detail.invites.length === 0 && <Empty>{t("No invites.")}</Empty>}
        {detail.invites.map((invite) => {
          const state = inviteState(invite);
          return (
            <div
              key={invite.code}
              className="flex items-center gap-3 px-4 py-3"
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setShownInvite(invite)}
              >
                <p className="font-mono font-semibold text-ink">
                  {invite.code}
                  <span className="ml-2 font-sans text-[10px] font-bold text-muted uppercase">
                    {invite.role}
                  </span>
                </p>
                <p className="text-xs text-muted">
                  {invite.usedCount}/{invite.maxUses} {t("used")} ·{" "}
                  {state ||
                    `${t("expires")} ${formatRelative(new Date(invite.expiresAt))}`}
                </p>
              </button>
              {!state && (
                <button
                  type="button"
                  className="shrink-0 text-xs font-semibold text-danger"
                  onClick={() => revokeInvite.mutate(invite.code)}
                >
                  {t("Revoke")}
                </button>
              )}
            </div>
          );
        })}
      </Section>

      <Section title={t("API keys")}>
        {detail.apiKeys.length === 0 && <Empty>{t("No API keys.")}</Empty>}
        {detail.apiKeys.map((key) => (
          <div key={key.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-ink">
                {key.name}
                {key.readOnly && (
                  <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
                    {t("read only")}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted">
                {key.revokedAt
                  ? t("revoked")
                  : key.lastUsedAt
                    ? `${t("last used")} ${formatRelative(new Date(key.lastUsedAt))}`
                    : t("never used")}
              </p>
            </div>
            {!key.revokedAt && (
              <button
                type="button"
                className="shrink-0 text-xs font-semibold text-danger"
                onClick={() => revokeKey.mutate(key.id)}
              >
                {t("Revoke")}
              </button>
            )}
          </div>
        ))}
      </Section>

      <Section title={t("Danger zone")}>
        <div className="space-y-2 px-4 py-3">
          <p className="text-xs text-muted">
            {t(
              "Deletes the family and every log, baby, invite and key in it. There is no undo.",
            )}
          </p>
          <DeleteButton
            label={t("Delete family")}
            onDelete={() => deleteFamily.mutate()}
          />
        </div>
      </Section>

      <MemberSheet
        detail={detail}
        member={selected}
        onClose={() => setSelected(null)}
        refresh={refresh}
      />
      <Sheet open={minting} onOpenChange={setMinting} title={t("Mint invite")}>
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted">
            {t(
              "An admin code makes whoever redeems it able to run the family — the way to repair one left with no admin.",
            )}
          </p>
          {FAMILY_ROLES.map((role) => (
            <Button
              key={role}
              size="full"
              variant={role === "admin" ? "outline" : "secondary"}
              disabled={mintInvite.isPending}
              onClick={() => mintInvite.mutate(role)}
            >
              {role === "admin" ? t("Mint admin code") : t("Mint member code")}
            </Button>
          ))}
        </div>
      </Sheet>
      <AddMemberSheet
        familyId={id}
        open={adding}
        onOpenChange={setAdding}
        refresh={refresh}
      />
      <Sheet
        open={!!shownInvite}
        onOpenChange={(o) => !o && setShownInvite(null)}
        title={t("Invite link")}
      >
        {shownInvite && (
          <div className="space-y-3 pb-4">
            <button
              type="button"
              className="w-full rounded-xl bg-surface-2 px-3 py-2 text-center font-mono text-sm break-all text-ink"
              onClick={() => {
                void navigator.clipboard?.writeText(shownInvite.url);
                toast(t("Link copied"));
              }}
            >
              {shownInvite.url}
            </button>
            <InviteQR url={shownInvite.url} />
          </div>
        )}
      </Sheet>
    </div>
  );
}
