import { Card } from "@/components/ui/card";
import { useBabies, useMe } from "@/lib/data";
import { t } from "@/lib/i18n";
import { type FamilySectionGroup, familySections } from "@/lib/settings-nav";
import { familyTracks } from "@/lib/tracking";
import { DevicesSection } from "./DevicesSection";
import { FamilySection } from "./FamilySection";
import { NavRow, SectionTitle, SettingsPage } from "./lib";

const groups: { key: FamilySectionGroup; title: string }[] = [
  { key: "lists", title: "Shared by the family" },
  { key: "data", title: "Data and integrations" },
];

// Settings → Family: what is the same whichever child you are looking at
// and whoever is holding the phone. The people come first and stay inline,
// because they are why anyone opens this page; everything else is a door.
export function FamilyPage() {
  const me = useMe();
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const babies = useBabies();
  const sections = familySections(isAdmin, (k) => familyTracks(babies.data, k));

  return (
    <SettingsPage title={t("Family")} back={{ to: "/settings" }}>
      <FamilySection isAdmin={isAdmin} />
      {isAdmin && <DevicesSection />}
      {groups.map((g) => (
        <div key={g.key}>
          <SectionTitle>{t(g.title)}</SectionTitle>
          <Card className="divide-y divide-line p-0">
            {sections
              .filter((s) => s.group === g.key)
              .map((s) => (
                <NavRow
                  key={s.key}
                  to="/settings/family/$section"
                  params={{ section: s.key }}
                  label={t(s.label)}
                />
              ))}
          </Card>
        </div>
      ))}
    </SettingsPage>
  );
}
