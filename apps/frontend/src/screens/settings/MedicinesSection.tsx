import { IconPill, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { MedicineSheet } from "@/components/sheets/MedicineSheet";
import { Card } from "@/components/ui/card";
import { useMedicineCatalogue } from "@/lib/data";
import { t } from "@/lib/i18n";
import { medicineDetail } from "@/lib/medicine-ui";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./lib";

// Settings → Family → Medicines (issue #49): the family's catalogue, the
// ContactsSection idiom. Archived entries stay listed, dimmed, so an old
// dose's medicine can still be found and restored.
export function MedicinesSection() {
  const medicines = useMedicineCatalogue();
  const [editEntry, setEditEntry] = useState<MedicineCatalogueEntry | null>(
    null,
  );
  const [adding, setAdding] = useState(false);

  const rows = medicines.data ?? [];

  return (
    <>
      <SectionTitle>{t("Medicines")}</SectionTitle>
      <Card className="divide-y divide-line p-0">
        {rows.map((m) => {
          const detail = medicineDetail(m);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setEditEntry(m)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2",
                m.archived && "opacity-60",
              )}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth">
                <IconPill className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">
                  {m.name}
                </span>
                {detail && (
                  <span className="block truncate text-sm text-muted">
                    {detail}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted">
            {t(
              "Paracetamol, vitamin D — the medicines you give, with the usual dose and how long you wait between doses.",
            )}
          </p>
        )}

        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left font-semibold text-ink-soft active:bg-surface-2"
        >
          <IconPlus className="h-5 w-5" />
          {t("Add medicine")}
        </button>
      </Card>

      <MedicineSheet
        open={!!editEntry}
        onOpenChange={(o) => !o && setEditEntry(null)}
        entry={editEntry}
      />
      <MedicineSheet open={adding} onOpenChange={setAdding} />
    </>
  );
}
