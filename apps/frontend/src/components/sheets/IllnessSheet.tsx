import { useState } from "react";
import type { IllnessLog, IllnessSymptom } from "@pjokk/shared";
import { illnessSymptoms } from "@pjokk/shared";
import {
  CaretakerChips,
  useCaretakerChoice,
} from "@/components/CaretakerChips";
import { ChipGroup, MultiChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDeleteIllness,
  useStartIllness,
  useUpdateIllness,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  FHI_URL,
  clearHourChoices,
  suggestedClearHours,
  symptomLabel,
} from "@/lib/illness-ui";
import { toast } from "@/lib/toast";

// An illness episode (issue #107). ONE sheet for create and edit. Opening
// one is the happy path — a symptom or two and Save — and it stays open
// until Home's card says Recovered; an edit of a finished one shows when it
// ended.
//
// The "hours before barnehage" row is the family's own number for THIS
// episode. It opens on 48 when the chips include vomiting or diarrhoea
// (FHI's guidance, linked beneath) and on None otherwise, follows the chips
// until the family touches it, and is never more than a number: the app
// says when those hours will have passed, not what to do then.
type ClearChoice = "none" | `${(typeof clearHourChoices)[number]}`;

export function IllnessSheet({
  open,
  onOpenChange,
  babyId,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  edit?: IllnessLog | null;
}) {
  const [time, setTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [symptoms, setSymptoms] = useState<IllnessSymptom[]>([]);
  // null until the family touches the row: then the suggestion stops
  // following the chips.
  const [clearChosen, setClearChosen] = useState<number | null | undefined>(
    undefined,
  );
  const [notes, setNotes] = useState("");
  const who = useCaretakerChoice(edit);

  const instance = useSheetReset(open, () => {
    setNotes(edit?.notes ?? "");
    who.reset();
    setSymptoms(edit?.symptoms ?? []);
    // An edit keeps what the episode has, a suggestion included.
    setClearChosen(edit ? edit.clearHours : undefined);
    setTime(edit ? new Date(edit.startTime) : null);
    setEndTime(edit?.endTime ? new Date(edit.endTime) : null);
  });

  const startIllness = useStartIllness();
  const updateIllness = useUpdateIllness();
  const deleteIllness = useDeleteIllness();
  const isOpenEdit = !!edit && edit.endTime === null;
  const clearHours =
    clearChosen === undefined ? suggestedClearHours(symptoms) : clearChosen;

  const toggle = (s: IllnessSymptom) =>
    setSymptoms((cur) =>
      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
    );

  const save = () => {
    const trimmed = notes.trim();
    if (edit) {
      updateIllness.mutate({
        id: edit.id,
        babyId,
        patch: {
          startTime: (time ?? new Date()).toISOString(),
          ...(isOpenEdit
            ? {}
            : { endTime: (endTime ?? new Date()).toISOString() }),
          symptoms,
          clearHours,
          notes: trimmed || null,
          ...who.field(),
        },
      });
    } else {
      startIllness.mutate({
        babyId,
        startTime: (time ?? new Date()).toISOString(),
        symptoms,
        ...(clearHours ? { clearHours } : {}),
        ...(trimmed ? { notes: trimmed } : {}),
        ...who.field(),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteIllness.mutate({ id: edit.id });
    onOpenChange(false);
  };

  const endsBeforeStart =
    !!edit &&
    !isOpenEdit &&
    !!time &&
    !!endTime &&
    endTime.getTime() < time.getTime();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit illness") : t("Illness")}
    >
      <div className="space-y-5 pb-4">
        <fieldset aria-label={t("Symptoms")}>
          <MultiChipGroup
            options={illnessSymptoms.map((s) => ({
              value: s,
              label: t(symptomLabel[s]),
            }))}
            values={symptoms}
            onToggle={toggle}
          />
        </fieldset>

        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {t("Started")}
        </p>
        <TimeField key={`s${instance}`} value={time} onChange={setTime} />

        {edit && !isOpenEdit && (
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

        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Symptom-free hours before daycare")}
          </p>
          <fieldset aria-label={t("Symptom-free hours before daycare")}>
            <ChipGroup<ClearChoice>
              options={[
                { value: "none", label: t("None") },
                ...clearHourChoices.map((h) => ({
                  value: `${h}` as ClearChoice,
                  label: `${h} ${t("h")}`,
                })),
              ]}
              value={clearHours ? (`${clearHours}` as ClearChoice) : "none"}
              onChange={(v) => setClearChosen(v === "none" ? null : Number(v))}
            />
          </fieldset>
          <p className="text-xs text-muted">
            {t(
              "Your own rule for this illness. FHI advises 48 hours after vomiting or diarrhoea, and otherwise going by how she is.",
            )}{" "}
            <a
              href={FHI_URL}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              fhi.no
            </a>
          </p>
        </div>

        <CaretakerChips choice={who} edit={edit} />

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

        <Button size="full" onClick={save} disabled={endsBeforeStart}>
          {t("Save")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
