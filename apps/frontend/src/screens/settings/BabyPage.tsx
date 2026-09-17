import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { prepareAvatar } from "@/lib/avatar-image";
import {
  useBabies,
  useDeleteBabyAvatar,
  useMe,
  useUploadBabyAvatar,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";
import { toast } from "@/lib/toast";
import { enabledLabels, useTracking } from "@/lib/tracking";
import { AboutMeCard } from "./AboutMeCard";
import { NavRow, SectionTitle, SettingsPage } from "./lib";
import { MedicineSheetCard } from "./MedicineSheetCard";
import { UsualNapCard } from "./NapGuideSection";
import { ReportCard } from "./ReportCard";

// Settings → <baby>: everything that is about ONE child. These cards used
// to sit in the single Settings scroll and act on whichever baby Home had
// selected, which nothing on the screen said; here the baby is in the URL
// and in the title, and Home's selection is left alone.
export function BabyPage({ babyId }: { babyId: string }) {
  const me = useMe();
  const babies = useBabies();
  const [editing, setEditing] = useState(false);
  const upload = useUploadBabyAvatar(babyId);
  const removePhoto = useDeleteBabyAvatar(babyId);
  const fileInput = useRef<HTMLInputElement>(null);
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const baby = babies.data?.find((b) => b.id === babyId);
  const track = useTracking(baby);

  if (!baby) {
    // Deleted a moment ago (the sheet below does that), a stale link, or
    // the list has not arrived yet.
    return (
      <SettingsPage title={t("Settings")} back={{ to: "/settings" }}>
        {babies.isPending ? null : (
          <p className="py-6 text-sm text-muted">
            {t("Page not found")}{" "}
            <Link to="/settings" className="font-semibold text-accent">
              {t("Back")}
            </Link>
          </p>
        )}
      </SettingsPage>
    );
  }

  // The same square crop and resize a person's photo gets (lib/avatar-image):
  // the server never sees the original.
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
  const busy = upload.isPending || removePhoto.isPending;

  return (
    <SettingsPage title={baby.name} back={{ to: "/settings" }}>
      <Card className="p-0">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-2"
        >
          <Avatar src={baby.avatarUrl} name={baby.name} size={11} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-ink">
              {baby.name}
            </span>
            <span className="block truncate text-xs text-muted">
              {formatAge(new Date(baby.birthDate))}
              {baby.sex ? "" : ` · ${t("sex not set")}`}
            </span>
          </span>
          <span className="text-sm font-semibold text-accent">{t("Edit")}</span>
        </button>
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={t("Change photo")}
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {t("Change photo")}
          </Button>
          {baby.avatarUrl && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                removePhoto.mutate(undefined, {
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
      <BabySheet
        open={editing}
        onOpenChange={setEditing}
        baby={baby}
        canDelete={isAdmin}
      />

      {/* What the family tracks for her (spec
          2026-09-17-per-baby-tracking-design.md): the door to the carousel,
          and the cards below follow their switches. */}
      <SectionTitle>{t("What to track")}</SectionTitle>
      <Card className="p-0">
        <NavRow
          to="/settings/baby/$babyId/tracking"
          params={{ babyId: baby.id }}
          label={t("What to track")}
          sub={
            track.any
              ? enabledLabels(baby)
                  .map((l) => t(l))
                  .join(" · ")
              : t("Nothing tracked yet")
          }
        />
      </Card>

      {track.has("sleep") && (
        <>
          <SectionTitle>{t("Usual nap")}</SectionTitle>
          <UsualNapCard baby={baby} />
        </>
      )}

      {track.has("daycare") && (
        <>
          <SectionTitle>{t("About the child, for daycare")}</SectionTitle>
          <AboutMeCard baby={baby} />

          <SectionTitle>{t("Medicines, for daycare")}</SectionTitle>
          <MedicineSheetCard baby={baby} />
        </>
      )}

      <SectionTitle>{t("PDF report")}</SectionTitle>
      <ReportCard baby={baby} />
    </SettingsPage>
  );
}
