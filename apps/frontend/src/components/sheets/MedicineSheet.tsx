import { useState } from "react";
import type { MedicineCatalogueEntry, MedicineUnit } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDeleteCatalogueMedicine,
  useSaveCatalogueMedicine,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  medicineIntervalLabel,
  medicineIntervalOptions,
} from "@/lib/medicine-ui";
import { toast } from "@/lib/toast";

// ONE sheet for adding and editing a catalogue entry (issue #49), the
// ContactSheet idiom. The interval is the family's own number: the app
// offers presets and never suggests one.
export function MedicineSheet({
  open,
  onOpenChange,
  entry = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry?: MedicineCatalogueEntry | null;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(2.5);
  const [unit, setUnit] = useState<MedicineUnit>("ml");
  const [interval, setInterval] = useState<number>(0);
  const [supplement, setSupplement] = useState(false);

  useSheetReset(open, () => {
    setName(entry?.name ?? "");
    setAmount(entry?.defaultAmount ?? 2.5);
    setUnit(entry?.unit ?? "ml");
    setInterval(entry?.minIntervalMin ?? 0);
    setSupplement(entry?.isSupplement ?? false);
  });

  const save = useSaveCatalogueMedicine(entry?.id);
  const remove = useDeleteCatalogueMedicine();

  const submit = (patch: { archived?: boolean } = {}) => {
    save.mutate(
      {
        name: name.trim(),
        defaultAmount: amount,
        unit,
        // 0 = off; PATCH clears with null, POST omits.
        minIntervalMin: interval || (entry ? null : undefined),
        isSupplement: supplement,
        ...patch,
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => toast(err.message, "error"),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? t("Edit medicine") : t("Add medicine")}
    >
      <div className="space-y-5 pb-4">
        <Input
          placeholder={t("Name (e.g. Paracetamol)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Usual dose")}
          </p>
          <ChipGroup
            options={[
              { value: "ml", label: "ml" },
              { value: "mg", label: "mg" },
              { value: "drops", label: t("drops") },
              { value: "dose", label: t("dose") },
            ]}
            value={unit}
            onChange={setUnit}
          />
          <Stepper
            value={amount}
            onChange={setAmount}
            step={unit === "mg" ? 50 : 0.5}
            decimals={unit === "mg" ? 0 : 1}
            min={0}
            max={unit === "mg" ? 1000 : 50}
            unit={unit}
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("At most every")}
          </p>
          <ChipGroup
            options={[
              { value: "0", label: t("Off") },
              ...medicineIntervalOptions.map((min) => ({
                value: String(min),
                label: medicineIntervalLabel(min),
              })),
            ]}
            value={String(interval)}
            onChange={(v) => setInterval(Number(v))}
          />
          <p className="text-xs text-muted">
            {t(
              "Your own rule from the leaflet or the doctor. The log sheet shows when the next dose is OK — it never stops you.",
            )}
          </p>
        </div>

        <ChipGroup
          options={[
            { value: "medicine", label: t("Medicine") },
            { value: "supplement", label: t("Supplement") },
          ]}
          value={supplement ? "supplement" : "medicine"}
          onChange={(v) => setSupplement(v === "supplement")}
        />

        <Button
          size="full"
          onClick={() => submit()}
          disabled={save.isPending || name.trim().length === 0}
        >
          {t("Save")}
        </Button>

        {entry && (
          <Button
            variant="secondary"
            size="full"
            onClick={() => submit({ archived: !entry.archived })}
            disabled={save.isPending}
          >
            {entry.archived ? t("Show in log sheet again") : t("Archive")}
          </Button>
        )}

        {entry && (
          <DeleteButton
            onDelete={() =>
              remove.mutate(entry.id, {
                onSuccess: () => {
                  toast(t("Medicine removed"));
                  onOpenChange(false);
                },
                onError: (err) => toast(err.message, "error"),
              })
            }
          />
        )}
      </div>
    </Sheet>
  );
}
