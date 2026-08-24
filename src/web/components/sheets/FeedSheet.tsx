import { useEffect, useMemo, useState } from "react";
import type { FeedLog } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { useLogFeed } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type FeedType = "bottle" | "breast" | "solids";
type Side = "left" | "right" | "both";

// Happy path is two taps: open → Save. Everything is prefilled from the last
// feed of the same type (CLAUDE.md §2–3).
export function FeedSheet({
  open,
  onOpenChange,
  babyId,
  recentFeeds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  recentFeeds: FeedLog[];
}) {
  const lastByType = useMemo(() => {
    const map = new Map<FeedType, FeedLog>();
    for (const f of recentFeeds) {
      if (!map.has(f.type)) map.set(f.type, f);
    }
    return map;
  }, [recentFeeds]);

  const defaultType: FeedType = recentFeeds[0]?.type ?? "bottle";
  const [type, setType] = useState<FeedType>(defaultType);
  const [amountMl, setAmountMl] = useState(120);
  const [side, setSide] = useState<Side>("left");
  const [durationMin, setDurationMin] = useState(15);
  const [time, setTime] = useState<Date | null>(null);

  // Re-prefill each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    const initial = recentFeeds[0]?.type ?? "bottle";
    setType(initial);
    setTime(null);
    applyPrefill(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyPrefill = (feedType: FeedType) => {
    const last = lastByType.get(feedType);
    if (feedType === "bottle" || feedType === "solids") {
      setAmountMl(last?.amountMl ?? 120);
    }
    if (feedType === "breast") {
      setSide(last?.side ?? "left");
      setDurationMin(last?.durationMin ?? 15);
    }
  };

  const changeType = (v: FeedType) => {
    setType(v);
    applyPrefill(v);
  };

  const logFeed = useLogFeed();
  const save = () => {
    logFeed.mutate(
      {
        babyId,
        time: (time ?? new Date()).toISOString(),
        type,
        ...(type === "breast"
          ? { side, durationMin }
          : { amountMl }),
      },
      {
        onError: (err) => toast(t("Could not save feed: ") + err.message, "error"),
      },
    );
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Feed")}>
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={[
            { value: "bottle", label: t("Bottle") },
            { value: "breast", label: t("Breast") },
            { value: "solids", label: t("Solids") },
          ]}
          value={type}
          onChange={changeType}
        />

        {(type === "bottle" || type === "solids") && (
          <Stepper
            value={amountMl}
            onChange={setAmountMl}
            step={10}
            min={10}
            max={500}
            unit="ml"
          />
        )}

        {type === "breast" && (
          <>
            <ChipGroup
              options={[
                { value: "left", label: t("Left") },
                { value: "right", label: t("Right") },
                { value: "both", label: t("Both") },
              ]}
              value={side}
              onChange={setSide}
            />
            <Stepper
              value={durationMin}
              onChange={setDurationMin}
              step={5}
              min={5}
              max={90}
              unit="min"
            />
          </>
        )}

        <TimeField value={time} onChange={setTime} />

        <Button size="full" onClick={save}>
          {t("Save")}
        </Button>
      </div>
    </Sheet>
  );
}
