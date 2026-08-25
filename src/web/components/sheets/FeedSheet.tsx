import { useMemo, useState } from "react";
import type { FeedLog } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeleteFeed, useLogFeed, useUpdateFeed } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type FeedType = "bottle" | "breast" | "solids";
type Side = "left" | "right" | "both";

// ONE component for create and edit (CLAUDE.md). Create: happy path is two
// taps, prefilled from the last feed of the same type. Edit: prefilled from
// the entry, plus delete.
export function FeedSheet({
  open,
  onOpenChange,
  babyId,
  recentFeeds,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  recentFeeds: FeedLog[];
  edit?: FeedLog | null;
}) {
  const lastByType = useMemo(() => {
    const map = new Map<FeedType, FeedLog>();
    for (const f of recentFeeds) {
      if (!map.has(f.type)) map.set(f.type, f);
    }
    return map;
  }, [recentFeeds]);

  const [type, setType] = useState<FeedType>("bottle");
  const [amountMl, setAmountMl] = useState(120);
  const [side, setSide] = useState<Side>("left");
  const [durationMin, setDurationMin] = useState(15);
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  // Bumped on every open so TimeField remounts with fresh initial state.
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

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

  // Initialize synchronously on open (state-during-render derived pattern),
  // so children mount with the right values.
  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    if (edit) {
      setType(edit.type);
      setAmountMl(edit.amountMl ?? 120);
      setSide(edit.side ?? "left");
      setDurationMin(edit.durationMin ?? 15);
      setTime(new Date(edit.time));
    } else {
      const initial = recentFeeds[0]?.type ?? "bottle";
      setType(initial);
      setTime(null);
      applyPrefill(initial);
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const changeType = (v: FeedType) => {
    setType(v);
    if (!edit) applyPrefill(v);
  };

  const logFeed = useLogFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();

  const save = () => {
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    if (edit) {
      updateFeed.mutate({
        id: edit.id,
        patch: {
          time: when,
          type,
          amountMl: type === "breast" ? null : amountMl,
          side: type === "breast" ? side : null,
          durationMin: type === "breast" ? durationMin : null,
          notes: trimmedNotes || null,
        },
      });
    } else {
      logFeed.mutate({
        babyId,
        time: when,
        type,
        ...(type === "breast" ? { side, durationMin } : { amountMl }),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteFeed.mutate({ id: edit.id });
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit feed") : t("Feed")}
    >
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

        <TimeField key={instance} value={time} onChange={setTime} />

        <Input
          placeholder={t("Note (optional)")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <Button size="full" onClick={save}>
          {t("Save")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
