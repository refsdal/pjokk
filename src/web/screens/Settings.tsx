import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { ApiKey, ApiKeyCreated, Baby, Invite } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { API_BASE, api, unwrap } from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";
import { useBabies, useInvites, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
} from "@/lib/push";
import { formatAge, formatRelative, toLocalDateInput } from "@/lib/time";
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

function BabyEditSheet({
  baby,
  onOpenChange,
}: {
  baby: Baby | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [sex, setSex] = useState<"girl" | "boy" | null>(null);
  const [wasOpen, setWasOpen] = useState(false);

  if (baby && !wasOpen) {
    setWasOpen(true);
    setName(baby.name);
    setBirthDate(toLocalDateInput(new Date(baby.birthDate)));
    setSex(baby.sex);
  }
  if (!baby && wasOpen) setWasOpen(false);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.babies[":id"].$patch({
          param: { id: baby!.id },
          json: {
            name: name.trim(),
            birthDate: new Date(birthDate).toISOString(),
            sex,
          },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["babies"] });
      onOpenChange(false);
    },
    onError: (err) => toast(err.message, "error"),
  });

  return (
    <Sheet open={!!baby} onOpenChange={onOpenChange} title={t("Edit baby")}>
      <div className="space-y-5 pb-4">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <ChipGroup
          options={[
            { value: "girl", label: t("Girl") },
            { value: "boy", label: t("Boy") },
          ]}
          value={sex}
          onChange={setSex}
        />
        <input
          type="date"
          value={birthDate}
          max={toLocalDateInput()}
          onChange={(e) => setBirthDate(e.target.value)}
          className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
        />
        <Button
          size="full"
          onClick={() => save.mutate()}
          disabled={save.isPending || name.trim().length === 0 || !birthDate}
        >
          {t("Save")}
        </Button>
        {!sex && (
          <p className="text-xs text-muted">
            {t("Sex is only used for WHO growth percentiles.")}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function ApiKeysSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [expiry, setExpiry] = useState<"never" | "90" | "365">("365");
  const [freshKey, setFreshKey] = useState<ApiKeyCreated | null>(null);

  const keys = useQuery({
    queryKey: ["apiKeys"],
    queryFn: async () => unwrap<ApiKey[]>(await api.keys.$get()),
  });

  const createKey = useMutation({
    mutationFn: async () =>
      unwrap<ApiKeyCreated>(
        await api.keys.$post({
          json: {
            name: name.trim(),
            readOnly,
            ...(expiry === "never"
              ? {}
              : { expiresInDays: Number(expiry) }),
          },
        }),
      ),
    onSuccess: (created) => {
      setFreshKey(created);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (err) => toast(err.message, "error"),
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.keys[":id"].$delete({ param: { id } })),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["apiKeys"] }),
  });

  const activeKeys = (keys.data ?? []).filter((k) => !k.revokedAt);

  return (
    <Card className="space-y-4">
      <p className="text-sm text-muted">
        {t(
          "Bearer keys for Home Assistant, Grafana & friends. Keys can read and log, but never manage the family.",
        )}
      </p>

      {freshKey && (
        <div className="space-y-2 rounded-xl2 bg-accent-soft p-3">
          <p className="text-xs font-semibold text-accent">
            {t("Copy this key now — it will never be shown again")}
          </p>
          <p className="font-mono text-xs break-all text-ink">{freshKey.key}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(freshKey.key)
                .then(() => toast(t("Key copied")))
            }
          >
            {t("Copy key")}
          </Button>
        </div>
      )}

      {activeKeys.map((k) => (
        <div key={k.id} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">
              {k.name}
              {k.readOnly && (
                <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold text-muted uppercase">
                  {t("read-only")}
                </span>
              )}
            </p>
            <p className="truncate font-mono text-xs text-muted">
              {k.prefix}…{" · "}
              {k.lastUsedAt
                ? `${t("used")} ${formatRelative(new Date(k.lastUsedAt))}`
                : t("never used")}
              {k.expiresAt
                ? ` · ${t("expires")} ${new Date(k.expiresAt).toLocaleDateString("nb-NO")}`
                : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() => revokeKey.mutate(k.id)}
          >
            {t("Revoke")}
          </Button>
        </div>
      ))}

      <div className="space-y-3">
        <Input
          placeholder={t("Key name (e.g. “Home Assistant”)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ChipGroup
          options={[
            { value: "rw", label: t("Read + write") },
            { value: "ro", label: t("Read-only") },
          ]}
          value={readOnly ? "ro" : "rw"}
          onChange={(v) => setReadOnly(v === "ro")}
        />
        <ChipGroup
          options={[
            { value: "90", label: t("90 days") },
            { value: "365", label: t("1 year") },
            { value: "never", label: t("Never expires") },
          ]}
          value={expiry}
          onChange={setExpiry}
        />
        <Button
          size="full"
          variant="secondary"
          disabled={createKey.isPending || name.trim().length === 0}
          onClick={() => createKey.mutate()}
        >
          {t("Create")}
        </Button>
      </div>
    </Card>
  );
}

function NotificationsSection() {
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    void currentSubscription().then((sub) => setSubscribed(!!sub));
  }, [supported]);

  const prefs = useQuery({
    queryKey: ["pushPrefs"],
    queryFn: async () =>
      unwrap<{ feedReminderHours: 0 | 3 | 4 | 6 }>(
        await api.push.prefs.$get(),
      ),
  });

  const savePrefs = useMutation({
    mutationFn: async (feedReminderHours: 0 | 3 | 4 | 6) =>
      unwrap(await api.push.prefs.$put({ json: { feedReminderHours } })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["pushPrefs"] }),
    onError: (err) => toast(err.message, "error"),
  });

  const togglePush = async () => {
    setBusy(true);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
      } else {
        await enablePush();
        setSubscribed(true);
        toast(t("Notifications enabled on this device"));
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : t("Push failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <Card>
        <p className="text-sm text-muted">
          {t(
            "Push is not available in this browser. On iPhone, add Pjokk to the Home Screen first.",
          )}
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <Button
        size="full"
        variant={subscribed ? "outline" : "primary"}
        disabled={busy || subscribed === null}
        onClick={() => void togglePush()}
      >
        {subscribed
          ? t("Disable on this device")
          : t("Enable notifications")}
      </Button>

      <div>
        <p className="pb-2 text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Remind me when no feed for")}
        </p>
        <ChipGroup
          options={[
            { value: "0", label: t("Off") },
            { value: "3", label: "3 h" },
            { value: "4", label: "4 h" },
            { value: "6", label: "6 h" },
          ]}
          value={String(prefs.data?.feedReminderHours ?? 0) as "0"}
          onChange={(v) => savePrefs.mutate(Number(v) as 0 | 3 | 4 | 6)}
        />
      </div>

      {subscribed && (
        <Button
          size="full"
          variant="ghost"
          onClick={() =>
            void sendTestPush().then((sent) =>
              toast(
                sent > 0
                  ? t("Test sent — check your notifications")
                  : t("No delivery — try re-enabling push"),
              ),
            )
          }
        >
          {t("Send test notification")}
        </Button>
      )}
    </Card>
  );
}

export function SettingsScreen() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const members = useMembers();
  const babies = useBabies();
  const {
    mode,
    setMode,
    schedule,
    setSchedule,
    themeMode,
    setThemeMode,
    languageMode,
    setLanguage,
  } = useAppearance();

  const myRole = members.data?.find(
    (m) => m.userId === session?.user.id,
  )?.role;
  const isAdmin = myRole === "admin" || myRole === "owner";

  const invites = useInvites(isAdmin);
  const [shownInvite, setShownInvite] = useState<Invite | null>(null);
  const [editBaby, setEditBaby] = useState<Baby | null>(null);

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
            <button
              key={b.id}
              type="button"
              onClick={() => setEditBaby(b)}
              className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-surface-2"
            >
              <p className="font-semibold text-ink">{b.name}</p>
              <p className="text-sm text-muted">
                {formatAge(new Date(b.birthDate))}
                {b.sex ? "" : ` · ${t("sex not set")}`}
              </p>
            </button>
          ))}
        </Card>

        <SectionTitle>{t("Notifications")}</SectionTitle>
        <NotificationsSection />

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

        <SectionTitle>{t("Language")}</SectionTitle>
        <Card>
          <ChipGroup
            options={[
              { value: "auto", label: t("Auto") },
              { value: "en", label: "English" },
              { value: "nb", label: "Norsk" },
            ]}
            value={languageMode}
            onChange={setLanguage}
          />
        </Card>

        <SectionTitle>{t("Night mode")}</SectionTitle>
        <Card className="space-y-4">
          <ChipGroup
            options={[
              {
                value: "auto",
                label: `${t("Auto")} (${schedule.startHour}–${String(schedule.endHour).padStart(2, "0")})`,
              },
              { value: "on", label: t("On") },
              { value: "off", label: t("Off") },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === "auto" && (
            <div className="space-y-3">
              <div>
                <p className="pb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("From")}
                </p>
                <ChipGroup
                  options={[
                    { value: "20", label: "20:00" },
                    { value: "21", label: "21:00" },
                    { value: "22", label: "22:00" },
                    { value: "23", label: "23:00" },
                  ]}
                  value={String(schedule.startHour) as "22"}
                  onChange={(v) =>
                    setSchedule({ ...schedule, startHour: Number(v) })
                  }
                />
              </div>
              <div>
                <p className="pb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("Until")}
                </p>
                <ChipGroup
                  options={[
                    { value: "6", label: "06:00" },
                    { value: "7", label: "07:00" },
                    { value: "8", label: "08:00" },
                  ]}
                  value={String(schedule.endHour) as "7"}
                  onChange={(v) =>
                    setSchedule({ ...schedule, endHour: Number(v) })
                  }
                />
              </div>
            </div>
          )}
        </Card>

        {isAdmin && (
          <>
            <SectionTitle>{t("API keys")}</SectionTitle>
            <ApiKeysSection />
          </>
        )}

        <SectionTitle>{t("Data")}</SectionTitle>
        <Card className="space-y-3">
          <p className="text-sm text-muted">
            {t("Everything ever logged, one row per entry — plain CSV.")}
          </p>
          <Button
            size="full"
            variant="outline"
            onClick={() => window.location.assign(`${API_BASE}/api/export.csv`)}
          >
            {t("Export CSV")}
          </Button>
        </Card>

        <SectionTitle>{t("Account")}</SectionTitle>
        <Card className="space-y-3">
          {(session?.user as { role?: string | null } | undefined)?.role ===
            "admin" && (
            <a
              href="/admin"
              className="block rounded-xl2 border border-line px-4 py-3 font-semibold text-ink active:bg-surface-2"
            >
              {t("Admin console")}
            </a>
          )}
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

        <BabyEditSheet
          baby={editBaby}
          onOpenChange={(o) => !o && setEditBaby(null)}
        />
      </div>
    </div>
  );
}
