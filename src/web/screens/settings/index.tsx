import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_BASE } from "@/lib/api";
import { isSysadmin, signOut, useSession } from "@/lib/auth-client";
import { useFamily, useMembers } from "@/lib/data";
import { t } from "@/lib/i18n";
import { ApiKeysSection } from "./ApiKeysSection";
import { AppearanceSection } from "./AppearanceSection";
import { BabiesSection } from "./BabiesSection";
import { BillingSection } from "./BillingSection";
import { FamilySection } from "./FamilySection";
import { SectionTitle } from "./lib";
import { NotificationsSection } from "./NotificationsSection";
import { SleepLocationsSection } from "./SleepLocationsSection";

export function SettingsScreen() {
  const { data: session } = useSession();
  const members = useMembers();
  const premium = (useFamily().data?.plan ?? "free") !== "free";

  const myRole = members.data?.find((m) => m.userId === session?.user.id)?.role;
  const isAdmin = myRole === "admin" || myRole === "owner";

  return (
    <div className="mx-auto max-w-md px-4 pt-safe">
      <h1 className="py-4 text-2xl font-extrabold text-ink">{t("Settings")}</h1>
      <div className="pb-tabbar">
        <FamilySection isAdmin={isAdmin} />
        <BabiesSection isAdmin={isAdmin} />

        {isAdmin && (
          <>
            <SectionTitle>{t("Sleep locations")}</SectionTitle>
            <SleepLocationsSection />
          </>
        )}

        <SectionTitle>{t("Notifications")}</SectionTitle>
        <NotificationsSection />

        <AppearanceSection />

        <BillingSection isAdmin={isAdmin} />

        {isAdmin && premium && (
          <>
            <SectionTitle>{t("API keys")}</SectionTitle>
            <ApiKeysSection />
          </>
        )}

        {isAdmin && !premium && (
          <>
            <SectionTitle>{t("API keys")}</SectionTitle>
            <Card className="space-y-3">
              <p className="text-sm text-muted">
                {t("API keys are a Premium feature.")}
              </p>
              <Button
                size="full"
                variant="outline"
                onClick={() =>
                  document
                    .getElementById("billing")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                {t("Upgrade")} · {t("Premium")}
              </Button>
            </Card>
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
            onClick={() =>
              premium
                ? window.location.assign(`${API_BASE}/api/export.csv`)
                : document
                    .getElementById("billing")
                    ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            {premium ? (
              t("Export CSV")
            ) : (
              <>
                {t("Export CSV")} · {t("Premium")}
              </>
            )}
          </Button>
        </Card>

        <SectionTitle>{t("Account")}</SectionTitle>
        <Card className="space-y-3">
          {isSysadmin(session) && (
            <Link
              to="/admin"
              className="block rounded-xl2 border border-line px-4 py-3 font-semibold text-ink active:bg-surface-2"
            >
              {t("Admin console")}
            </Link>
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
      </div>
    </div>
  );
}
