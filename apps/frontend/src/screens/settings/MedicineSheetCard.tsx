import { IconFileTypePdf } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Baby } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useMedicineCatalogue } from "@/lib/data";
import { t } from "@/lib/i18n";
import { medicineSheetRows } from "@/lib/medicine-sheet";
import { toast } from "@/lib/toast";

// A sheet for the barnehage (issue #113): staff may not give medicine
// without the parents' written instructions. One page for THIS baby, from
// the family's own catalogue — which is the family's, so it is edited on
// the Family page and only read here.
export function MedicineSheetCard({ baby }: { baby: Baby }) {
  const medicines = useMedicineCatalogue();
  const [building, setBuilding] = useState(false);
  const rows = medicineSheetRows(medicines.data ?? [], t);

  const make = async () => {
    setBuilding(true);
    try {
      const { buildMedicineSheet } = await import("@/lib/medicine-sheet");
      await buildMedicineSheet({ baby, rows, t });
    } catch (err) {
      toast(
        `${t("Could not build the page")}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Card className="space-y-3">
      <p className="text-sm text-muted">
        {t(
          "One page with the family's medicines and blank lines for when, how and how long, to sign and hand to the staff.",
        )}{" "}
        <Link
          to="/settings/family/$section"
          params={{ section: "medicines" }}
          className="underline"
        >
          {t("Edit the medicines")}
        </Link>
      </p>
      <Button
        size="full"
        variant="outline"
        disabled={building || rows.length === 0}
        onClick={() => void make()}
      >
        <span className="inline-flex items-center gap-1.5">
          <IconFileTypePdf className="h-4 w-4" />
          {building
            ? t("Building…")
            : `${t("Sheet for daycare (PDF)")} · ${baby.name}`}
        </span>
      </Button>
    </Card>
  );
}
