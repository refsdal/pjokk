import { IconFileTypePdf } from "@tabler/icons-react";
import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { buildReport, type ReportRange } from "@/lib/report";
import { useSelectedBaby } from "@/lib/selected-baby";
import { toast } from "@/lib/toast";
import { useUnits } from "@/lib/units";

// Settings → Data → PDF report (issue #53): the last week or month for the
// selected baby, built in the browser (lib/report.ts).
export function ReportCard() {
  const { baby } = useSelectedBaby();
  const units = useUnits();
  const [days, setDays] = useState<ReportRange>(7);
  const [busy, setBusy] = useState(false);

  const make = async () => {
    if (!baby) return;
    setBusy(true);
    try {
      await buildReport({ baby, days, units });
    } catch (err) {
      toast(
        `${t("Could not build the report")}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <p className="text-sm text-muted">
        {t(
          "A one-file summary for the helsestasjon or the doctor: sleep, intake, growth with percentiles, temperatures, medicines and vaccines. Built on this device.",
        )}
      </p>
      <ChipGroup
        options={[
          { value: "7", label: t("Last 7 days") },
          { value: "30", label: t("Last 30 days") },
        ]}
        value={String(days)}
        onChange={(v) => setDays(Number(v) as ReportRange)}
      />
      <Button
        size="full"
        variant="outline"
        disabled={!baby || busy}
        onClick={() => void make()}
      >
        <span className="inline-flex items-center gap-1.5">
          <IconFileTypePdf className="h-4 w-4" />
          {busy
            ? t("Building…")
            : `${t("Download PDF report")}${baby ? ` · ${baby.name}` : ""}`}
        </span>
      </Button>
    </Card>
  );
}
