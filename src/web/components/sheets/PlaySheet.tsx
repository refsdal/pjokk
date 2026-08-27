import { useState } from "react";
import type { PlayLog, PlayType } from "@shared/schemas";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDeletePlay,
  useLogPlay,
  useStartPlay,
  useUpdatePlay,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { playKindMeta, playTypeOrder } from "@/lib/play-ui";
import { toast } from "@/lib/toast";

// ONE component for create and edit, like SleepSheet. Creating offers both
// paths side by side: start a running timer (stopped from the home banner),
// or log a session that already finished — retroactive logging is the norm
// (CLAUDE.md §4), so the timer is never the only way in.
export function PlaySheet({
  open,
  onOpenChange,
  babyId,
  type: initialType = "tummy",
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  type?: PlayType;
  edit?: PlayLog | null;
}) {
  const [type, setType] = useState<PlayType>(initialType);
  const [time, setTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    setType(edit?.type ?? initialType);
    setTime(edit ? new Date(edit.startTime) : null);
    setEndTime(edit?.endTime ? new Date(edit.endTime) : null);
  }
  if (!open && wasOpen) setWasOpen(false);

  const startPlay = useStartPlay();
  const logPlay = useLogPlay();
  const updatePlay = useUpdatePlay();
  const deletePlay = useDeletePlay();
  const isRunningEdit = !!edit && edit.endTime === null;

  const offlineNote = () => {
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const startTimer = () => {
    startPlay.mutate({
      babyId,
      type,
      startTime: (time ?? new Date()).toISOString(),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    offlineNote();
  };

  const save = () => {
    const trimmedNotes = notes.trim();
    if (edit) {
      updatePlay.mutate({
        id: edit.id,
        patch: {
          type,
          startTime: (time ?? new Date()).toISOString(),
          // Never end a running session from here — that is the banner's job.
          ...(isRunningEdit
            ? {}
            : { endTime: (endTime ?? new Date()).toISOString() }),
          notes: trimmedNotes || null,
        },
      });
    } else {
      const start = time ?? new Date();
      const end = endTime ?? new Date();
      logPlay.mutate({
        babyId,
        type,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    }
    offlineNote();
  };

  const remove = () => {
    if (!edit) return;
    deletePlay.mutate({ id: edit.id });
    onOpenChange(false);
  };

  // Guard the one nonsensical entry: a session that ended before it began.
  const endsBeforeStart =
    !!time && !!endTime && endTime.getTime() < time.getTime();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit activity") : t(playKindMeta[type].label)}
    >
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={playTypeOrder.map((k) => ({
            value: k,
            label: t(playKindMeta[k].label),
          }))}
          value={type}
          onChange={setType}
        />

        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Started")}
        </p>
        <TimeField key={`s${instance}`} value={time} onChange={setTime} />

        {isRunningEdit ? (
          <p className="text-sm text-muted">
            {t("Still running — finish it with Stop on Home.")}
          </p>
        ) : (
          <>
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("Ended")}
            </p>
            <TimeField
              key={`e${instance}`}
              value={endTime}
              onChange={setEndTime}
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

        {edit ? (
          <Button size="full" onClick={save} disabled={endsBeforeStart}>
            {t("Save")}
          </Button>
        ) : (
          <>
            <Button size="full" onClick={startTimer}>
              {t("Start timer")}
            </Button>
            <Button
              size="full"
              variant="outline"
              onClick={save}
              disabled={endsBeforeStart}
            >
              {t("Log finished activity")}
            </Button>
          </>
        )}

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
