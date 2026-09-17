import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_BASE } from "@/lib/api";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { type FamilySectionKey, familySection } from "@/lib/settings-nav";
import { ApiKeysSection } from "./ApiKeysSection";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { CareDaysSection } from "./CareDaysSection";
import { ContactsSection } from "./ContactsSection";
import { DaycarePlaceSection } from "./DaycarePlaceSection";
import { SettingsPage } from "./lib";
import { MedicinesSection } from "./MedicinesSection";
import { PhotoUsageLine } from "./PhotoUsageLine";
import { SleepLocationsSection } from "./SleepLocationsSection";

function ExportCard() {
  return (
    <Card className="space-y-3">
      <p className="text-sm text-muted">
        {t("Everything ever logged, one row per entry — plain CSV.")}{" "}
        {t("Always metric (ml, kg, cm, °C), whatever your display units.")}
      </p>
      {/* Never paywalled: this is how a family exercises their right of
          access and portability. */}
      <Button
        size="full"
        variant="outline"
        onClick={() => window.location.assign(`${API_BASE}/api/export.csv`)}
      >
        {t("Export CSV")}
      </Button>
      <PhotoUsageLine />
    </Card>
  );
}

// Settings → Family → one section, as its own page. The sections are the
// ones the old single Settings screen stacked; which exist, and for whom,
// is lib/settings-nav.ts.
export function FamilySubPage({ section }: { section: string }) {
  const me = useMe();
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const meta = familySection(section, isAdmin);

  if (!meta) {
    // An unknown segment, or an admin-only page opened by a member. While
    // /api/me is still loading this is every admin-only page, so say
    // nothing until the role is known.
    return (
      <SettingsPage title={t("Family")} back={{ to: "/settings/family" }}>
        {me.isPending ? null : (
          <p className="py-6 text-sm text-muted">
            {t("Page not found")}{" "}
            <Link to="/settings/family" className="font-semibold text-accent">
              {t("Back")}
            </Link>
          </p>
        )}
      </SettingsPage>
    );
  }

  const body: Record<FamilySectionKey, ReactNode> = {
    contacts: <ContactsSection />,
    daycare: <DaycarePlaceSection isAdmin={isAdmin} />,
    medicines: <MedicinesSection />,
    "sleep-locations": <SleepLocationsSection />,
    "care-days": <CareDaysSection isAdmin={isAdmin} />,
    "api-keys": <ApiKeysSection />,
    "calendar-feed": <CalendarFeedCard />,
    data: <ExportCard />,
  };

  return (
    <SettingsPage title={t(meta.label)} back={{ to: "/settings/family" }}>
      {body[meta.key]}
    </SettingsPage>
  );
}
