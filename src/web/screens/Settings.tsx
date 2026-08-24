import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { Invite } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";
import { useBabies, useInvites, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";
import { formatAge } from "@/lib/time";
import { toast } from "@/lib/toast";

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="px-1 pt-5 pb-2 text-xs font-bold tracking-wider text-muted uppercase">
      {children}
    </h2>
  );
}

function InviteQR({ url }: { url: string }) {
  const { data } = useQuery({
    queryKey: ["qr", url],
    queryFn: () =>
      QRCode.toDataURL(url, { width: 480, margin: 1 }),
    staleTime: Infinity,
  });
  if (!data) return <div className="mx-auto h-48 w-48 rounded-xl bg-surface-2" />;
  return (
    <img
      src={data}
      alt={t("Invite QR code")}
      className="mx-auto h-48 w-48 rounded-xl"
    />
  );
}

export function SettingsScreen() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const members = useMembers();
  const babies = useBabies();
  const { mode, setMode, themeMode, setThemeMode } = useAppearance();

  const myRole = members.data?.find(
    (m) => m.userId === session?.user.id,
  )?.role;
  const isAdmin = myRole === "admin" || myRole === "owner";

  const invites = useInvites(isAdmin);
  const [shownInvite, setShownInvite] = useState<Invite | null>(null);

  const activeInvites = (invites.data ?? []).filter(
    (i) =>
      !i.revokedAt &&
      new Date(i.expiresAt) > new Date() &&
      i.usedCount < i.maxUses,
  );

  // Keep showing the newest active invite by default.
  useEffect(() => {
    if (!shownInvite && activeInvites[0]) setShownInvite(activeInvites[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="mx-auto max-w-md px-4 pt-safe">
      <h1 className="py-4 text-2xl font-extrabold text-ink">{t("Settings")}</h1>
      <div className="pb-tabbar">
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
                  <p className="text-center font-mono text-lg font-bold tracking-widest text-ink">
                    {shownInvite.code}
                  </p>
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

        <SectionTitle>{t("Babies")}</SectionTitle>
        <Card className="divide-y divide-line p-0">
          {(babies.data ?? []).map((b) => (
            <div key={b.id} className="flex items-center justify-between px-4 py-3">
              <p className="font-semibold text-ink">{b.name}</p>
              <p className="text-sm text-muted">
                {formatAge(new Date(b.birthDate))}
              </p>
            </div>
          ))}
        </Card>

        <SectionTitle>{t("Appearance")}</SectionTitle>
        <Card>
          <ChipGroup
            options={[
              { value: "system", label: t("System") },
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
            ]}
            value={themeMode}
            onChange={setThemeMode}
          />
        </Card>

        <SectionTitle>{t("Night mode")}</SectionTitle>
        <Card>
          <ChipGroup
            options={[
              { value: "auto", label: t("Auto (22–07)") },
              { value: "on", label: t("On") },
              { value: "off", label: t("Off") },
            ]}
            value={mode}
            onChange={setMode}
          />
        </Card>

        <SectionTitle>{t("Account")}</SectionTitle>
        <Card className="space-y-3">
          <p className="text-sm text-ink-soft">
            {session?.user.name}
            <span className="block text-xs text-muted">
              {session?.user.email}
            </span>
          </p>
          <Button
            size="full"
            variant="outline"
            onClick={() =>
              void signOut().then(() => window.location.assign("/login"))
            }
          >
            {t("Sign out")}
          </Button>
        </Card>

        <p className="py-6 text-center text-xs text-muted">
          <a href="/api/docs" className="underline">
            {t("API docs")}
          </a>
          {" · Pjokk 0.1"}
        </p>
      </div>
    </div>
  );
}
