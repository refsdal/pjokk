import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { Invite } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";
import { useInvites, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { SectionTitle } from "./lib";

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
  const members = useMembers();
  const invites = useInvites(isAdmin);
  const [shownInvite, setShownInvite] = useState<Invite | null>(null);

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
        await api.invites.$post({
          json: { role: "member", expiresInHours: 72, maxUses: 5 },
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
      unwrap(await api.invites[":code"].$delete({ param: { code } })),
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
        {(members.data ?? []).map((m) => (
          <div key={m.userId} className="flex items-center gap-3 px-4 py-3">
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
          </div>
        ))}
      </Card>

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
