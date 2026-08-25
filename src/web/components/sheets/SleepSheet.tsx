import { useState } from "react";
import type { SleepLog } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeleteSleep, useStartSleep, useUpdateSleep } from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type Location = "crib" | "stroller" | "arms";

// ONE component for create and edit. Create starts a session (waking happens
// on the home banner); edit adjusts times/location/notes of any entry — for
// an active session the end time stays untouched (endTime null).
export function SleepSheet({
  open,
  onOpenChange,
  babyId,
  lastLocation,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  lastLocation: string | null;
  edit?: SleepLog | null;
}) {
  const [location, setLocation] = useState<Location | null>(null);
  const [time, setTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  const asLocation = (v: string | null): Location =>
    v === "crib" || v === "stroller" || v === "arms" ? v : "crib";

  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    if (edit) {
      setLocation(edit.location ? asLocation(edit.location) : null);
      setTime(new Date(edit.startTime));
      setEndTime(edit.endTime ? new Date(edit.endTime) : null);
    } else {
      setLocation(asLocation(lastLocation));
      setTime(null);
      setEndTime(null);
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const startSleep = useStartSleep();
  const updateSleep = useUpdateSleep();
  const deleteSleep = useDeleteSleep();
  const isActiveEdit = !!edit && edit.endTime === null;

  const save = () => {
    const trimmedNotes = notes.trim();
    if (edit) {
      updateSleep.mutate({
        id: edit.id,
        patch: {
          startTime: (time ?? new Date()).toISOString(),
          // Never touch the end time of a running session from here.
          ...(isActiveEdit
            ? {}
            : { endTime: (endTime ?? new Date()).toISOString() }),
          location,
          notes: trimmedNotes || null,
        },
      });
    } else {
      startSleep.mutate({
        babyId,
        startTime: (time ?? new Date()).toISOString(),
        ...(location ? { location } : {}),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteSleep.mutate({ id: edit.id });
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit sleep") : t("Sleep")}
    >
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

        {edit && (
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Fell asleep")}
          </p>
        )}
        <TimeField key={`s${instance}`} value={time} onChange={setTime} />

        {edit &&
          (isActiveEdit ? (
            <p className="text-sm text-muted">
              {t("Still sleeping — end the session with Wake on Home.")}
            </p>
          ) : (
            <>
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                {t("Woke up")}
              </p>
              <TimeField
                key={`e${instance}`}
                value={endTime}
                onChange={setEndTime}
              />
            </>
          ))}

        <Input
          placeholder={t("Note (optional)")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <Button size="full" onClick={save}>
          {edit ? t("Save") : t("Start sleep")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
