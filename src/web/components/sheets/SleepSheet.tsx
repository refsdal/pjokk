import { useEffect, useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { useStartSleep } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type Location = "crib" | "stroller" | "arms";

// Starting a sleep session. Waking happens straight from the home banner.
export function SleepSheet({
  open,
  onOpenChange,
  babyId,
  lastLocation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  lastLocation: string | null;
}) {
  const [location, setLocation] = useState<Location | null>(null);
  const [time, setTime] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocation(
      lastLocation === "crib" ||
        lastLocation === "stroller" ||
        lastLocation === "arms"
        ? lastLocation
        : "crib",
    );
    setTime(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startSleep = useStartSleep();
  const save = () => {
    startSleep.mutate(
      {
        babyId,
        startTime: (time ?? new Date()).toISOString(),
        ...(location ? { location } : {}),
      },
      {
        onError: (err) =>
          toast(t("Could not start sleep: ") + err.message, "error"),
      },
    );
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Sleep")}>
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={[
            { value: "crib", label: t("Crib") },
            { value: "stroller", label: t("Stroller") },
            { value: "arms", label: t("Arms") },
          ]}
          value={location}
          onChange={setLocation}
        />
        <TimeField value={time} onChange={setTime} />
        <Button size="full" onClick={save}>
          {t("Start sleep")}
        </Button>
      </div>
    </Sheet>
  );
}
