import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { BabySheet } from "@/components/sheets/BabySheet";
import { Card } from "@/components/ui/card";
import { useBabies, useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";
import { AboutMeCard } from "./AboutMeCard";
import { SectionTitle, SettingsPage } from "./lib";
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
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const baby = babies.data?.find((b) => b.id === babyId);

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

  return (
    <SettingsPage title={baby.name} back={{ to: "/settings" }}>
      <Card className="p-0">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-2"
        >
          <Avatar src={null} name={baby.name} size={11} />
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
      </Card>
      <BabySheet
        open={editing}
        onOpenChange={setEditing}
        baby={baby}
        canDelete={isAdmin}
      />

      <SectionTitle>{t("Usual nap")}</SectionTitle>
      <UsualNapCard baby={baby} />

      <SectionTitle>{t("About the child, for daycare")}</SectionTitle>
      <AboutMeCard baby={baby} />

      <SectionTitle>{t("Medicines, for daycare")}</SectionTitle>
      <MedicineSheetCard baby={baby} />

      <SectionTitle>{t("PDF report")}</SectionTitle>
      <ReportCard baby={baby} />
    </SettingsPage>
  );
}
