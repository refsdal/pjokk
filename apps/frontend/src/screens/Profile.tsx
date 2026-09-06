import { IconChevronLeft } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { ErrorState, LoadingState } from "@/components/QueryStates";
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
import { toast } from "@/lib/toast";
import { SectionTitle } from "./settings/lib";

// /profile — the person, as opposed to Settings, which is the family and the
// device (spec §4). Global: the same nickname and photo in every family.
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
  if (me.data && !seeded) {
    setSeeded(true);
    setName(me.data.name);
    setNickname(me.data.nickname ?? "");
    setPhone(me.data.phone ?? "");
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
    <div className="mx-auto max-w-md px-4 pt-safe">
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
      </div>
    </div>
  );
}
