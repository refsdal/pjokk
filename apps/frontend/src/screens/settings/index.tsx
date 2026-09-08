import { IconChevronRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_BASE } from "@/lib/api";
import { signOut } from "@/lib/auth-client";
import { useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { legalUrl } from "@/lib/site";
import { ApiKeysSection } from "./ApiKeysSection";
import { AppearanceSection } from "./AppearanceSection";
import { BabiesSection } from "./BabiesSection";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { ContactsSection } from "./ContactsSection";
import { FamilySection } from "./FamilySection";
import { InstallSection } from "./InstallSection";
import { MedicinesSection } from "./MedicinesSection";
import { NapGuideSection } from "./NapGuideSection";
import { PhotoUsageLine } from "./PhotoUsageLine";
import { SectionTitle } from "./lib";
import { NotificationsSection } from "./NotificationsSection";
import { ReportCard } from "./ReportCard";
import { SleepLocationsSection } from "./SleepLocationsSection";

export function SettingsScreen() {
  // The family role used to be derived by matching the session's user id
  // against the member list; /api/me reports it directly, from the same
  // membership row the server enforces on.
  const me = useMe();

  const myRole = me.data?.memberRole;
  const isAdmin = myRole === "admin" || myRole === "owner";

  return (
    <div className="mx-auto max-w-md px-4 pt-safe md:max-w-lg md:px-6">
      <h1 className="py-4 text-2xl font-extrabold text-ink">{t("Settings")}</h1>
      <div className="pb-tabbar">
        <FamilySection isAdmin={isAdmin} />
        <BabiesSection isAdmin={isAdmin} />
        <ContactsSection />
        <MedicinesSection />

        {isAdmin && (
          <>
            <SectionTitle>{t("Sleep locations")}</SectionTitle>
            <SleepLocationsSection />
          </>
        )}

        <NapGuideSection />

        <SectionTitle>{t("Notifications")}</SectionTitle>
        <NotificationsSection />

        <AppearanceSection />

        {isAdmin && (
          <>
            <SectionTitle>{t("API keys")}</SectionTitle>
            <ApiKeysSection />
          </>
        )}

        <InstallSection />

        <SectionTitle>{t("Data")}</SectionTitle>
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

        <SectionTitle>{t("PDF report")}</SectionTitle>
        <ReportCard />

        <SectionTitle>{t("Calendar subscription")}</SectionTitle>
        <CalendarFeedCard />

        <SectionTitle>{t("About")}</SectionTitle>
        <Card className="divide-y divide-line p-0">
          {/* Plain anchors, not <Link>: these pages left the SPA in the
              landing split (PR #17) and now live on the public apex, where
              they are prerendered and readable without an account. */}
          <a
            href={legalUrl("privacy")}
            className="block px-4 py-3 font-semibold text-ink active:bg-surface-2"
          >
            {t("Privacy policy")}
          </a>
          <a
            href={legalUrl("terms")}
            className="block px-4 py-3 font-semibold text-ink active:bg-surface-2"
          >
            {t("Terms")}
          </a>
        </Card>

        <SectionTitle>{t("Account")}</SectionTitle>
        <Card className="space-y-3">
          {me.data?.role === "admin" && (
            <Link
              to="/admin"
              className="block rounded-xl2 border border-line px-4 py-3 font-semibold text-ink active:bg-surface-2"
            >
              {t("Admin console")}
            </Link>
          )}
          <Link
            to="/profile"
            className="flex min-h-14 items-center gap-3 rounded-xl2 border border-line px-4 py-2 active:bg-surface-2"
          >
            <Avatar
              src={me.data?.avatarUrl}
              name={me.data?.displayName ?? "?"}
              size={9}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-ink">
                {me.data?.displayName}
              </span>
              <span className="block truncate text-xs text-muted">
                {me.data?.email}
              </span>
            </span>
            <IconChevronRight className="h-5 w-5 text-muted" />
          </Link>
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
          {/* The server's build version — the image tag, not a number kept
              by hand (internal/buildinfo). */}
          {me.data ? ` · Pjokk ${me.data.version}` : null}
        </p>
      </div>
    </div>
  );
}
