import { ChipGroup } from "@/components/Chips";
import { Card } from "@/components/ui/card";
import { useAppearance } from "@/lib/appearance";
import { t } from "@/lib/i18n";
import { SectionTitle } from "./lib";

export function AppearanceSection() {
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

  return (
    <>
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
    </>
  );
}
