import { IconDeviceMobilePlus } from "@tabler/icons-react";
import { useState } from "react";
import { InstallSheet } from "@/components/InstallSheet";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { useInstallState } from "@/lib/install";
import { SectionTitle } from "./lib";

// The permanent home for the install instructions. The banner on Home is
// dismissible and one-time; this row is how someone finds their way back to
// it afterwards — or finds it at all, having never seen the banner.
//
// Hidden when there is nothing useful to say: already installed, or a
// desktop browser with no install path worth explaining.
export function InstallSection() {
  const state = useInstallState();
  const [sheet, setSheet] = useState(false);

  if (state === "installed" || state === "unsupported") return null;

  return (
    <>
      <SectionTitle>{t("Install")}</SectionTitle>
      <Card className="p-0">
        <button
          type="button"
          onClick={() => setSheet(true)}
          className="flex w-full items-center gap-3 px-4 py-4 text-left active:bg-surface-2"
        >
          <IconDeviceMobilePlus className="h-5 w-5 shrink-0 text-accent" />
          <span className="flex-1 text-sm font-semibold text-ink">
            {t("Add to home screen")}
          </span>
        </button>
      </Card>
      <InstallSheet open={sheet} onOpenChange={setSheet} />
    </>
  );
}
