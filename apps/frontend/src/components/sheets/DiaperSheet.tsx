import { useState } from "react";
import type { DiaperLog } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeleteDiaper, useLogDiaper, useUpdateDiaper } from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  type DiaperColor,
  type DiaperConsistency,
  diaperColorOptions,
  diaperConsistencyOptions,
} from "@/lib/log-detail";
import { toast } from "@/lib/toast";

type DiaperType = "wet" | "dirty" | "both" | "dry";

// ONE component for create and edit (CLAUDE.md).
export function DiaperSheet({
  open,
  onOpenChange,
  babyId,
  lastDiaper,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  lastDiaper: DiaperLog | null;
  edit?: DiaperLog | null;
}) {
  const [type, setType] = useState<DiaperType>("wet");
  // Colour/consistency describe stool, so they only apply to dirty/both.
  // They are observations of THIS change and are never prefilled from the
  // last one — a silently repeated "green · loose" would be a false record.
  const [color, setColor] = useState<DiaperColor | null>(null);
  const [consistency, setConsistency] = useState<DiaperConsistency | null>(
    null,
  );
  const [showDetail, setShowDetail] = useState(false);
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");

  const instance = useSheetReset(open, () => {
    setNotes(edit?.notes ?? "");
    if (edit) {
      setType(edit.type);
      setColor(edit.color ?? null);
      setConsistency(edit.consistency ?? null);
      setShowDetail(!!(edit.color || edit.consistency));
      setTime(new Date(edit.time));
    } else {
      setType(lastDiaper?.type ?? "wet");
      setColor(null);
      setConsistency(null);
      setShowDetail(false);
      setTime(null);
    }
  });

  const logDiaper = useLogDiaper();
  const updateDiaper = useUpdateDiaper();
  const deleteDiaper = useDeleteDiaper();

  const hasStool = type === "dirty" || type === "both";

  const save = () => {
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    // Detail belongs to a stool; switching to wet/dry drops it.
    const colorOut = hasStool ? color : null;
    const consistencyOut = hasStool ? consistency : null;
    if (edit) {
      updateDiaper.mutate({
        id: edit.id,
        patch: {
          time: when,
          type,
          color: colorOut,
          consistency: consistencyOut,
          notes: trimmedNotes || null,
        },
      });
    } else {
      logDiaper.mutate({
        babyId,
        time: when,
        type,
        ...(colorOut ? { color: colorOut } : {}),
        ...(consistencyOut ? { consistency: consistencyOut } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteDiaper.mutate({ id: edit.id });
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit diaper") : t("Diaper")}
    >
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={[
            { value: "wet", label: t("Wet") },
            { value: "dirty", label: t("Dirty") },
            { value: "both", label: t("Both") },
            { value: "dry", label: t("Dry") },
          ]}
          value={type}
          onChange={setType}
        />

        {hasStool &&
          (showDetail ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                {t("Colour")}
              </p>
              <ChipGroup
                options={diaperColorOptions.map((o) => ({
                  value: o.value,
                  label: t(o.label),
                }))}
                value={color}
                // Optional field: tapping the selected chip clears it.
                onChange={(v) => setColor(v === color ? null : v)}
              />
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                {t("Consistency")}
              </p>
              <ChipGroup
                options={diaperConsistencyOptions.map((o) => ({
                  value: o.value,
                  label: t(o.label),
                }))}
                value={consistency}
                onChange={(v) => setConsistency(v === consistency ? null : v)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDetail(true)}
              className="px-1 text-sm text-muted underline"
            >
              {t("Add detail")}
            </button>
          ))}

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
