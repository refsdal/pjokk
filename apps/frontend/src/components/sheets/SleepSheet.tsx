import { useState } from "react";
import type { SleepLog } from "@pjokk/shared";
import {
  CaretakerChips,
  useCaretakerChoice,
} from "@/components/CaretakerChips";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { TimeField, TimeRow } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDeleteSleep,
  useResumeSleep,
  useSleepLocations,
  useStartSleep,
  useSummary,
  useUpdateSleep,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { sleepTypeAt } from "@/lib/night";
import { canResumeEdit } from "@/lib/sleep-resume";
import { formatDuration } from "@/lib/time";
import { toast } from "@/lib/toast";
import { cn, focusRing } from "@/lib/utils";

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
  const [location, setLocation] = useState<string | null>(null);
  // Nap or night. Defaulted from the device's night-mode schedule at the
  // moment the sheet opens; null on an edit of a row logged before the
  // field existed, and the server never guesses (it has no timezone).
  const [type, setType] = useState<"nap" | "night" | null>(null);
  const [time, setTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const who = useCaretakerChoice(edit);

  const instance = useSheetReset(open, () => {
    setNotes(edit?.notes ?? "");
    who.reset();
    if (edit) {
      setLocation(edit.location ?? null);
      setType(edit.type ?? null);
      setTime(new Date(edit.startTime));
      setEndTime(edit.endTime ? new Date(edit.endTime) : null);
    } else {
      setLocation(lastLocation);
      setType(sleepTypeAt(new Date()));
      setTime(null);
      setEndTime(null);
    }
  });

  const startSleep = useStartSleep();
  const updateSleep = useUpdateSleep();
  const deleteSleep = useDeleteSleep();
  const resumeSleep = useResumeSleep();
  const isActiveEdit = !!edit && edit.endTime === null;
  // Resume is offered on the newest sleep only, which takes the summary to
  // know. Queried only while an edit is open: the sheet stays mounted on the
  // Timeline, and the summary polls.
  const summary = useSummary(open && edit ? edit.babyId : undefined);
  const resumable = !!edit && canResumeEdit(edit, summary.data);

  // How long the sleep lasted as currently edited — the same reading the
  // timeline row gives. Nothing while it is running, or once the end has
  // been dragged before the start.
  const endsAt = endTime ?? (edit && !isActiveEdit ? new Date() : null);
  const duration =
    edit && !isActiveEdit && time && endsAt && endsAt > time
      ? formatDuration(endsAt.getTime() - time.getTime())
      : null;

  const custom = useSleepLocations().data ?? [];
  const locationOptions = [
    { value: "crib", label: t("Crib") },
    { value: "stroller", label: t("Stroller") },
    { value: "arms", label: t("Contact nap") },
    ...custom.map((l) => ({ value: l.name, label: l.name })),
  ];
  // A stored value not in the list (deleted custom location, legacy data)
  // still renders — append it as a transient chip.
  if (location && !locationOptions.some((o) => o.value === location)) {
    locationOptions.push({ value: location, label: location });
  }

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
          type,
          notes: trimmedNotes || null,
          ...who.field(),
        },
      });
    } else {
      startSleep.mutate({
        babyId,
        startTime: (time ?? new Date()).toISOString(),
        ...(location ? { location } : {}),
        ...(type ? { type } : {}),
        ...who.field(),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  // Only the end time: anything else changed in the sheet is not saved.
  const resume = () => {
    if (!edit) return;
    resumeSleep.mutate({ id: edit.id, babyId: edit.babyId });
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
          options={locationOptions}
          value={location}
          onChange={setLocation}
        />

        <ChipGroup
          options={[
            { value: "nap", label: t("Nap") },
            { value: "night", label: t("Night") },
          ]}
          value={type}
          onChange={setType}
        />

        {edit ? (
          // Edit: each time folded into a row (TimeRow) so Save stays on
          // screen; the times sit in one group with the duration line and
          // Resume beneath.
          <div className="space-y-2">
            <TimeRow
              key={`s${instance}`}
              label={t("Fell asleep")}
              value={time}
              onChange={setTime}
            />
            {isActiveEdit ? (
              <p className="px-1 py-2 text-sm text-muted">
                {t("Still sleeping — end the session with Wake on Home.")}
              </p>
            ) : (
              <>
                <TimeRow
                  key={`e${instance}`}
                  label={t("Woke up")}
                  value={endTime}
                  onChange={setEndTime}
                />
                {(duration || resumable) && (
                  <div className="flex items-center gap-1.5 px-1 text-sm text-muted">
                    {duration && <span>{duration}</span>}
                    {duration && resumable && <span aria-hidden="true">·</span>}
                    {resumable && (
                      // A text action, not a button block: Resume corrects a
                      // Wake tapped too soon, and must never read as the
                      // sheet's primary verb next to Save.
                      <button
                        type="button"
                        onClick={resume}
                        className={cn(
                          "h-11 rounded-md font-semibold text-accent select-none active:opacity-70",
                          focusRing,
                        )}
                      >
                        {t("Resume sleep")}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <TimeField key={`s${instance}`} value={time} onChange={setTime} />
        )}

        <CaretakerChips choice={who} edit={edit} />

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
