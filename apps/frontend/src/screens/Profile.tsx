import { IconChevronLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { prepareAvatar } from "@/lib/avatar-image";
import {
  useDeleteAvatar,
  useMe,
  useUpdateMe,
  useUploadAvatar,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { signOut } from "@/lib/auth-client";
import { toast } from "@/lib/toast";
import { AppearanceSection } from "./settings/AppearanceSection";
import { InstallSection } from "./settings/InstallSection";
import { NavRow, SectionTitle } from "./settings/lib";
import { NapGuideSection } from "./settings/NapGuideSection";
import { NotificationsSection } from "./settings/NotificationsSection";

// /profile — the person, as opposed to Settings, which is the family and its
// babies (spec §4). Who you are is global: the same nickname and photo in
// every family. Below that sit the settings that are yours or this
// device's — notifications, appearance, night mode, the nap guide, install,
// sign out — which the Settings restructure moved here from the old single
// Settings scroll.
export function ProfileScreen() {
  const me = useMe();
  const updateMe = useUpdateMe();
  const upload = useUploadAvatar();
  const removeAvatar = useDeleteAvatar();
  const fileInput = useRef<HTMLInputElement>(null);

  // Plain state, seeded once from the server (BabySheet's pattern).
  const [seeded, setSeeded] = useState(false);
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [units, setUnits] = useState<"metric" | "imperial">("metric");
  if (me.data && !seeded) {
    setSeeded(true);
    setName(me.data.name);
    setNickname(me.data.nickname ?? "");
    setPhone(me.data.phone ?? "");
    setUnits(me.data.units === "imperial" ? "imperial" : "metric");
  }

  if (me.isPending) return <LoadingState />;
  if (me.isError || !me.data) {
    return <ErrorState onRetry={() => void me.refetch()} />;
  }
  const profile = me.data;

  const save = () => {
    if (!name.trim()) {
      toast(t("Name cannot be blank"), "error");
      return;
    }
    updateMe.mutate(
      {
        name: name.trim(),
        nickname: nickname.trim() || null,
        phone: phone.trim() || null,
        units,
      },
      {
        onSuccess: () => toast(t("Profile saved")),
        onError: (err) => toast(err.message, "error"),
      },
    );
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const blob = await prepareAvatar(file);
      upload.mutate(blob, {
        onSuccess: () => toast(t("Photo updated")),
        onError: (err) => toast(err.message, "error"),
      });
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t("Could not read that image"),
        "error",
      );
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const busy = updateMe.isPending || upload.isPending || removeAvatar.isPending;

  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6">
      <div className="flex items-center gap-2 py-4">
        <Link
          to="/settings"
          aria-label={t("Back")}
          className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
        >
          <IconChevronLeft className="h-6 w-6" />
        </Link>
        <h1 className="text-2xl font-extrabold text-ink">
          {t("Your profile")}
        </h1>
      </div>

      <div className="space-y-3 pb-tabbar">
        <Card className="flex flex-col items-center gap-3">
          <Avatar
            src={profile.avatarUrl}
            name={profile.displayName}
            size={20}
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={t("Change photo")}
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {t("Change photo")}
            </Button>
            {profile.avatarUrl && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  removeAvatar.mutate(undefined, {
                    onSuccess: () => toast(t("Photo removed")),
                    onError: (err) => toast(err.message, "error"),
                  })
                }
              >
                {t("Remove photo")}
              </Button>
            )}
          </div>
        </Card>

        <SectionTitle>{t("About you")}</SectionTitle>
        <Card className="space-y-4">
          <div className="space-y-1">
            <label
              htmlFor="profile-name"
              className="text-xs font-semibold text-muted"
            >
              {t("Full name")}
            </label>
            <Input
              id="profile-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="profile-nickname"
              className="text-xs font-semibold text-muted"
            >
              {t("Nickname")}
            </label>
            <Input
              id="profile-nickname"
              value={nickname}
              maxLength={40}
              onChange={(e) => setNickname(e.target.value)}
            />
            <span className="block text-xs text-muted">
              {t("Shown instead of your full name everywhere")}
            </span>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="profile-phone"
              className="text-xs font-semibold text-muted"
            >
              {t("Phone")}
            </label>
            <Input
              id="profile-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              maxLength={32}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <span className="text-xs font-semibold text-muted">
              {t("Units")}
            </span>
            <ChipGroup
              options={[
                { value: "metric", label: t("Metric (ml, kg, cm, °C)") },
                { value: "imperial", label: t("Imperial (oz, lb, in, °F)") },
              ]}
              value={units}
              onChange={setUnits}
            />
            <span className="block text-xs text-muted">
              {t(
                "Only how numbers are shown to you — everyone's entries are stored the same way.",
              )}
            </span>
          </div>
          <div className="space-y-1">
            <span className="text-xs font-semibold text-muted">
              {t("Email")}
            </span>
            <p className="text-base text-ink">{profile.email}</p>
            <span className="block text-xs text-muted">
              {t("Sign-in address")}
            </span>
          </div>
          <Button size="full" disabled={busy} onClick={save}>
            {t("Save")}
          </Button>
        </Card>

        {/* The sections below bring their own SectionTitle spacing; the
            wrapper undoes this column's space-y so they sit as they did
            on Settings. */}
        <div className="space-y-0">
          <SectionTitle>{t("Notifications")}</SectionTitle>
          <NotificationsSection />

          <AppearanceSection />
          <NapGuideSection />
          <InstallSection />

          {/* Dismissing the line on Home must lose nothing (issue #140),
              so both ways back live here. */}
          <SectionTitle>{t("About")}</SectionTitle>
          <Card className="divide-y divide-line p-0">
            <NavRow to="/whats-new" label={t("What's new")} />
            <NavRow to="/getting-started" label={t("Getting started")} />
          </Card>

          <SectionTitle>{t("Account")}</SectionTitle>
          <Card className="space-y-3">
            {profile.role === "admin" && (
              <Link
                to="/admin"
                className="block rounded-xl2 border border-line px-4 py-3 font-semibold text-ink active:bg-surface-2"
              >
                {t("Admin console")}
              </Link>
            )}
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
        </div>
      </div>
    </div>
  );
}
