import { ChipGroup } from "@/components/Chips";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { setNapGuide, useNapGuide } from "@/lib/nap-window";
import { SectionTitle } from "./lib";

// The nap-window guide's one switch (issue #46), with the one-line
// disclaimer the feature owes: it is a typical-for-her-age guide from a
// cited table, not advice, and tired signs beat any table.
export function NapGuideSection() {
  const enabled = useNapGuide();
  return (
    <>
      <SectionTitle>{t("Nap window")}</SectionTitle>
      <Card className="space-y-3">
        <ChipGroup
          options={[
            { value: "on", label: t("On") },
            { value: "off", label: t("Off") },
          ]}
          value={enabled ? "on" : "off"}
          onChange={(v) => setNapGuide(v === "on")}
        />
        <p className="text-sm text-muted">
          {t(
            "Shows a typical nap window for her age on the Awake card, from a pediatrician-reviewed table (Cleveland Clinic, 2024). A guide, not advice: babies differ from day to day, and tired signs beat any table.",
          )}
        </p>
      </Card>
    </>
  );
}
