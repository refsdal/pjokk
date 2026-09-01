import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { Invite, Member } from "@pjokk/shared";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { client, unwrap } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { useInvites, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

// Household admin's member controls: promote/demote + remove. better-auth's
// org plugin enforces the permissions server-side; the client also guards
// against demoting/removing the last admin so a family can't strand itself.
function MemberSheet({
  member,
  familyId,
  adminCount,
  onClose,
}: {
  member: Member | null;
  familyId: string | undefined;
  adminCount: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isAdminRole = member?.role === "admin" || member?.role === "owner";
  const lastAdmin = isAdminRole && adminCount <= 1;

  const done = (message: string) => {
    toast(message);
    void queryClient.invalidateQueries({ queryKey: ["members"] });
    onClose();
  };

  const setRole = useMutation({
    mutationFn: async (role: "admin" | "member") => {
      const res = await authClient.organization.updateMemberRole({
        memberId: member!.memberId,
        role,
        organizationId: familyId,
      });
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => done(t("Role updated")),
    onError: (err) => toast(err.message, "error"),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.removeMember({
        memberIdOrEmail: member!.memberId,
        organizationId: familyId,
      });
      if (res.error) throw new Error(res.error.message);
    },
    onSuccess: () => done(t("Removed from the family")),
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={member?.name ?? ""}
    >
      {member && (
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted">
            {member.email} · {isAdminRole ? t("admin") : t("member")}
          </p>

          <Button
            size="full"
            variant="outline"
            disabled={setRole.isPending || lastAdmin}
            onClick={() => setRole.mutate(isAdminRole ? "member" : "admin")}
          >
            {isAdminRole ? t("Make member") : t("Make admin")}
          </Button>

          {lastAdmin ? (
            <p className="text-xs text-muted">
              {t("The family needs at least one admin.")}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted">
                {t(
                  "Removing someone keeps their past entries, attributed as before.",
                )}
              </p>
              <DeleteButton
                label={t("Remove from family")}
                onDelete={() => remove.mutate()}
              />
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function InviteQR({ url }: { url: string }) {
  const { data } = useQuery({
    queryKey: ["qr", url],
    queryFn: () => QRCode.toDataURL(url, { width: 480, margin: 1 }),
    staleTime: Infinity,
  });
  if (!data)
    return <div className="mx-auto h-48 w-48 rounded-xl bg-surface-2" />;
  return (
    <img
      src={data}
      alt={t("Invite QR code")}
      className="mx-auto h-48 w-48 rounded-xl"
    />
  );
}

export function FamilySection({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const members = useMembers();
  const invites = useInvites(isAdmin);
  const [shownInvite, setShownInvite] = useState<Invite | null>(null);
  const [manageMember, setManageMember] = useState<Member | null>(null);
  const familyId = session?.session.activeOrganizationId ?? undefined;
  const adminCount = (members.data ?? []).filter(
    (m) => m.role === "admin" || m.role === "owner",
  ).length;

  const activeInvites = (invites.data ?? []).filter(
    (i) =>
      !i.revokedAt &&
      new Date(i.expiresAt) > new Date() &&
      i.usedCount < i.maxUses,
  );

  // Keep showing the newest active invite by default.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when fresh data lands
  useEffect(() => {
    if (!shownInvite && activeInvites[0]) setShownInvite(activeInvites[0]);
  }, [invites.data]);

  const createInvite = useMutation({
    mutationFn: async () =>
      unwrap<Invite>(
        client.POST("/api/invites", {
          body: { role: "member", expiresInHours: 72, maxUses: 5 },
        }),
      ),
    onSuccess: (invite) => {
      setShownInvite(invite);
      void queryClient.invalidateQueries({ queryKey: ["invites"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  const revokeInvite = useMutation({
    mutationFn: async (code: string) =>
      unwrap(
        client.DELETE("/api/invites/{code}", { params: { path: { code } } }),
      ),
    onSuccess: () => {
      setShownInvite(null);
      void queryClient.invalidateQueries({ queryKey: ["invites"] });
    },
    // A failed revoke must never look like success — the code stays live.
    onError: (err) => toast(err.message, "error"),
  });

  const copyInvite = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t("Invite link copied"));
    } catch {
      toast(url);
    }
  };

  return (
    <>
      <SectionTitle>{t("Family")}</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {(members.data ?? []).map((m) => {
          const manageable = isAdmin && m.userId !== session?.user.id;
          const row = (
            <>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent">
                {m.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-ink">{m.name}</p>
                <p className="truncate text-xs text-muted">{m.email}</p>
              </div>
              <span className="text-xs font-semibold text-muted">
                {m.role === "member" ? t("member") : t("admin")}
              </span>
            </>
          );
          return manageable ? (
            <button
              key={m.userId}
              type="button"
              onClick={() => setManageMember(m)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2"
            >
              {row}
            </button>
          ) : (
            <div key={m.userId} className="flex items-center gap-3 px-4 py-3">
              {row}
            </div>
          );
        })}
      </Card>

      <MemberSheet
        member={manageMember}
        familyId={familyId}
        adminCount={adminCount}
        onClose={() => setManageMember(null)}
      />

      {isAdmin && (
        <>
          <SectionTitle>{t("Invite a caretaker")}</SectionTitle>
          <Card className="space-y-4">
            {shownInvite ? (
              <>
                <InviteQR url={shownInvite.url} />
                <div className="text-center">
                  <p className="font-mono text-lg font-bold tracking-widest text-ink">
                    {shownInvite.code}
                  </p>
                  {/* For the grandparent who can't scan: where to type it. */}
                  <p className="text-xs text-muted">
                    {shownInvite.url.replace(/^https?:\/\//, "")}
                  </p>
                </div>
                <p className="text-center text-xs text-muted">
                  {t("Expires ")}
                  {new Date(shownInvite.expiresAt).toLocaleString("nb-NO")}
                  {" · "}
                  {shownInvite.usedCount}/{shownInvite.maxUses} {t("used")}
                </p>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    variant="secondary"
                    onClick={() => void copyInvite(shownInvite.url)}
                  >
                    {t("Copy link")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => revokeInvite.mutate(shownInvite.code)}
                  >
                    {t("Revoke")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">
                {t(
                  "Create a link and show the QR to whoever is joining — it expires after 72 hours.",
                )}
              </p>
            )}
            <Button
              size="full"
              variant={shownInvite ? "outline" : "primary"}
              onClick={() => createInvite.mutate()}
              disabled={createInvite.isPending}
            >
              {t("New invite link")}
            </Button>
          </Card>
        </>
      )}
    </>
  );
}
