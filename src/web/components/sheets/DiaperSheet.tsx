import { useEffect, useState } from "react";
import type { DiaperLog } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { useLogDiaper } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type DiaperType = "wet" | "dirty" | "both";

export function DiaperSheet({
  open,
  onOpenChange,
  babyId,
  lastDiaper,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  lastDiaper: DiaperLog | null;
}) {
  const [type, setType] = useState<DiaperType>("wet");
  const [time, setTime] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(lastDiaper?.type ?? "wet");
    setTime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const logDiaper = useLogDiaper();
  const save = () => {
    logDiaper.mutate(
      { babyId, time: (time ?? new Date()).toISOString(), type },
      {
        onError: (err) =>
          toast(t("Could not save diaper: ") + err.message, "error"),
      },
    );
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Diaper")}>
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={[
            { value: "wet", label: t("Wet") },
            { value: "dirty", label: t("Dirty") },
            { value: "both", label: t("Both") },
          ]}
          value={type}
          onChange={setType}
        />
        <TimeField value={time} onChange={setTime} />
        <Button size="full" onClick={save}>
          {t("Save")}
        </Button>
      </div>
    </Sheet>
  );
}
