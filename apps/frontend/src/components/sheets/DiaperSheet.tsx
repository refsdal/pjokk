import { useState } from "react";
import type { DiaperLog } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeleteDiaper, useLogDiaper, useUpdateDiaper } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type DiaperType = "wet" | "dirty" | "both";

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
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    if (edit) {
      setType(edit.type);
      setTime(new Date(edit.time));
    } else {
      setType(lastDiaper?.type ?? "wet");
      setTime(null);
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const logDiaper = useLogDiaper();
  const updateDiaper = useUpdateDiaper();
  const deleteDiaper = useDeleteDiaper();

  const save = () => {
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    if (edit) {
      updateDiaper.mutate({
        id: edit.id,
        patch: { time: when, type, notes: trimmedNotes || null },
      });
    } else {
      logDiaper.mutate({
        babyId,
        time: when,
        type,
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
          ]}
          value={type}
          onChange={setType}
        />
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
