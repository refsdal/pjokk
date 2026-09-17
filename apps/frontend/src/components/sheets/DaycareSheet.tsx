import { useState } from "react";
import type { DaycareLog } from "@pjokk/shared";
import {
  CaretakerChips,
  useCaretakerChoice,
} from "@/components/CaretakerChips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDaycares,
  useDeleteDaycare,
  useDropOff,
  useLogDaycare,
  useMe,
  useUpdateDaycare,
} from "@/lib/data";
import { usualDropOff } from "@/lib/daycare-ui";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

// A day at barnehage (issue #105). ONE component for create and edit, like
// PlaySheet, and the same two ways in: Drop off starts the running session
// (ended by Pick up on Home), or log a day that is already over —
// retroactive logging is the norm (CLAUDE.md §4). Unlike PlaySheet the
// finished-day fields stay folded until asked for: the drop-off is the
// everyday path, done at the gate with a child on one arm, and it should
// be a time, a face and one button.
//
// Two people belong to a day there. The ordinary chips say who dropped off;
// a second row says who picked up, and only where a pick-up exists: a
// finished day being logged, or a finished day being edited.
export function DaycareSheet({
  open,
  onOpenChange,
  babyId,
  edit = null,
  onHandover,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  edit?: DaycareLog | null;
  // Opens the handover sheet for a finished day (issue #106). The parent
  // owns that sheet — one tray at a time — so this only hands the day over.
  onHandover?: (day: DaycareLog) => void;
}) {
  const me = useMe();
  const [time, setTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  // Create only: the pick-up fields unfolded, to log a day already over.
  const [finished, setFinished] = useState(false);
  const who = useCaretakerChoice(edit);
  // The pick-up person: null until tapped. On a new finished day the chips
  // start on yourself (and the server defaults nobody, so it is always
  // sent); on an edit they start on the row's, which may be nobody at all.
  const [pickupChosen, setPickupChosen] = useState<string | null>(null);
  const pickupBaseline = edit
    ? edit.pickupCaretakerId
    : (me.data?.userId ?? null);
  const pickup = {
    value: pickupChosen ?? pickupBaseline,
    choose: setPickupChosen,
  };

  const instance = useSheetReset(open, () => {
    setNotes(edit?.notes ?? "");
    who.reset();
    setFinished(false);
    setPickupChosen(null);
    setTime(edit ? new Date(edit.startTime) : null);
    setEndTime(edit?.endTime ? new Date(edit.endTime) : null);
  });

  // The previous day, for the finished-day prefill (lib/daycare-ui.ts).
  const recent = useDaycares(babyId, 1, open && !edit);
  const unfoldFinished = () => {
    if (!time) setTime(usualDropOff(recent.data?.[0]?.startTime));
    setFinished(true);
  };

  const dropOff = useDropOff();
  const logDaycare = useLogDaycare();
  const updateDaycare = useUpdateDaycare();
  const deleteDaycare = useDeleteDaycare();
  const isRunningEdit = !!edit && edit.endTime === null;

  const offlineNote = () => {
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const startNow = () => {
    dropOff.mutate({
      babyId,
      startTime: (time ?? new Date()).toISOString(),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...who.field(),
    });
    offlineNote();
  };

  const save = () => {
    const trimmedNotes = notes.trim();
    if (edit) {
      updateDaycare.mutate({
        id: edit.id,
        patch: {
          startTime: (time ?? new Date()).toISOString(),
          // Never end a running session from here — that is the banner's job.
          ...(isRunningEdit
            ? {}
            : { endTime: (endTime ?? new Date()).toISOString() }),
          notes: trimmedNotes || null,
          ...who.field(),
          ...(pickupChosen && pickupChosen !== edit.pickupCaretakerId
            ? { pickupCaretakerId: pickupChosen }
            : {}),
        },
      });
    } else {
      logDaycare.mutate({
        babyId,
        startTime: (time ?? new Date()).toISOString(),
        endTime: (endTime ?? new Date()).toISOString(),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        ...who.field(),
        ...(pickup.value ? { pickupCaretakerId: pickup.value } : {}),
      });
    }
    offlineNote();
  };

  const remove = () => {
    if (!edit) return;
    deleteDaycare.mutate({ id: edit.id });
    onOpenChange(false);
  };

  // Guard the one nonsensical entry: a day that ended before it began.
  const showsPickUp = edit ? !isRunningEdit : finished;
  const endsBeforeStart =
    showsPickUp && !!time && !!endTime && endTime.getTime() < time.getTime();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit daycare day") : t("Daycare")}
    >
      <div className="space-y-5 pb-4">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Dropped off")}
        </p>
        {/* Keyed on `finished` too: unfolding may prefill the drop-off, and
            the field reads its chip ("Pick time") from the value it mounts
            with. */}
        <TimeField
          key={`s${instance}${finished}`}
          value={time}
          onChange={setTime}
        />

        <CaretakerChips choice={who} edit={edit} label="Dropped off by" />

        {isRunningEdit && (
          <p className="text-sm text-muted">
            {t("Still there — finish the day with Pick up on Home.")}
          </p>
        )}
        {showsPickUp && (
          <>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Picked up")}
            </p>
            <TimeField
              key={`e${instance}`}
              value={endTime}
              onChange={setEndTime}
            />
            <CaretakerChips
              choice={pickup}
              label="Picked up by"
              testId="pickup-chips"
            />
          </>
        )}

        <Input
          placeholder={t("Note (optional)")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {endsBeforeStart && (
          <p className="text-sm text-diaper">
            {t("The end time is before the start time.")}
          </p>
        )}

        {edit || finished ? (
          <Button size="full" onClick={save} disabled={endsBeforeStart}>
            {t("Save")}
          </Button>
        ) : (
          <>
            <Button size="full" onClick={startNow}>
              {t("Drop off")}
            </Button>
            <Button size="full" variant="outline" onClick={unfoldFinished}>
              {t("Log a finished day")}
            </Button>
          </>
        )}

        {edit && !isRunningEdit && onHandover && (
          <Button
            size="full"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onHandover(edit);
            }}
          >
            {t("Handover")}
          </Button>
        )}

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
