import { measurementMeta } from "@/lib/measurements";
import {
  IconAlertTriangle,
  IconBath,
  IconHandStop,
  IconMilk,
  IconNote,
  IconPhoto,
  IconPill,
  IconRuler,
  IconSparkles,
  IconTrash,
  IconVaccine,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type {
  FeedTimer,
  MeasurementType,
  MedicineCatalogueEntry,
  MilestonePhoto,
  MedicineUnit,
  PlayType,
  TimelineEntry,
} from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isOptimisticTimer,
  photoSrc,
  useCreateOther,
  useDeleteMilestonePhoto,
  useDeleteOther,
  useMedicineCatalogue,
  useOtherList,
  useUploadMilestonePhoto,
  useStartFeedTimer,
  useStopFeedTimer,
  useUpdateOther,
  type CreateOtherVars,
  type OtherKind,
} from "@/lib/data";
import { minutesFromSeconds, totalSeconds } from "@/lib/feed-timer-ui";
import { measurementScale, useUnits } from "@/lib/units";
import { t } from "@/lib/i18n";
import { nextDoseFrom } from "@/lib/medicine-ui";
import { playKindMeta, playTypeOrder } from "@/lib/play-ui";
import { formatClock } from "@/lib/time";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type OtherEntry = Extract<TimelineEntry, { kind: OtherKind }>;

export const otherKindMeta: Record<
  OtherKind,
  { label: string; icon: TablerIcon; tint: string }
> = {
  medicine: { label: "Medicine", icon: IconPill, tint: "text-growth" },
  bath: { label: "Bath", icon: IconBath, tint: "text-diaper" },
  note: { label: "Note", icon: IconNote, tint: "text-muted" },
  milestone: { label: "Milestone", icon: IconSparkles, tint: "text-accent" },
  measurement: { label: "Measurement", icon: IconRuler, tint: "text-growth" },
  pump: { label: "Pump", icon: IconMilk, tint: "text-feed" },
};

// The "More" picker: the extra activity types, vaccines, and asking another
// caretaker for a hand — one tap each.
export type MoreAction = {
  key: string;
  label: string;
  icon: TablerIcon;
  tint: string;
  pick: () => void;
};

export type MoreHandlers = {
  onPick: (kind: OtherKind) => void;
  onPickPlay: (type: PlayType) => void;
  onPickHelp: () => void;
  onVaccines: () => void;
};

// The "More" actions, in display order: the six generic kinds, the three
// play kinds (timed sessions with their own endpoints, so they sit beside
// the generic kinds rather than inside otherKindMeta), the vaccines
// screen, and asking another caretaker for help. ONE list, rendered by the
// phone's More sheet below and by Home's unfolded tiles at md and up
// (components/HomeActions.tsx) — test/more-actions.test.ts pins the order.
export function moreActions(h: MoreHandlers): MoreAction[] {
  return [
    ...(Object.keys(otherKindMeta) as OtherKind[]).map((kind) => ({
      key: kind,
      ...otherKindMeta[kind],
      pick: () => h.onPick(kind),
    })),
    ...playTypeOrder.map((type) => ({
      key: `play:${type}`,
      ...playKindMeta[type],
      pick: () => h.onPickPlay(type),
    })),
    // Vaccines open a screen, not a sheet — the programme schedule needs
    // more room than a tray.
    {
      key: "vaccines",
      label: "Vaccines",
      icon: IconVaccine,
      tint: "text-growth",
      pick: h.onVaccines,
    },
    // Not a log at all — a ping to another caretaker. Lives here because
    // More is the one place every extra action is reachable from.
    {
      key: "help",
      label: "Ask for help",
      icon: IconHandStop,
      tint: "text-danger",
      pick: h.onPickHelp,
    },
  ];
}

export function MoreSheet({
  open,
  onOpenChange,
  onPick,
  onPickPlay,
  onPickHelp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (kind: OtherKind) => void;
  onPickPlay: (type: PlayType) => void;
  onPickHelp: () => void;
}) {
  const navigate = useNavigate();

  const tiles = moreActions({
    onPick,
    onPickPlay,
    onPickHelp,
    onVaccines: () => {
      onOpenChange(false);
      void navigate({ to: "/vaccines" });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Log something")}>
      <div className="grid grid-cols-3 gap-3 pt-1 pb-6">
        {tiles.map(({ key, label, icon: Icon, tint, pick }) => {
          return (
            <button
              key={key}
              type="button"
              onClick={pick}
              className="flex h-24 flex-col items-center justify-center gap-2 rounded-xl2 border border-line bg-surface select-none active:scale-[0.97] active:bg-surface-2"
            >
              <span
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center rounded-full bg-surface-2",
                  tint,
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="text-sm font-bold text-ink">{t(label)}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ONE sheet for all six Phase 3 types, create and edit — the Phase 1 sheet
// pattern instantiated over a kind switch instead of six near-identical
// components.
export function OtherLogSheet({
  open,
  onOpenChange,
  babyId,
  kind,
  edit = null,
  initialMeasurementType = "weight",
  activePump = null,
  stopTimer = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  kind: OtherKind;
  edit?: OtherEntry | null;
  // Which measurement type the sheet opens on. Only meaningful for
  // kind="measurement"; ignored otherwise.
  initialMeasurementType?: MeasurementType;
  // The family's running pump timer (issue #44), and whether this open is
  // the banner's Stop: then the duration follows the clock and Save stops
  // the timer instead of logging a fresh row. Only meaningful for
  // kind="pump".
  activePump?: FeedTimer | null;
  stopTimer?: boolean;
}) {
  const recent = useOtherList(kind, babyId, open && !edit);
  const units = useUnits();
  const startFeedTimer = useStartFeedTimer();
  const stopFeedTimer = useStopFeedTimer();
  const pumpTimer = kind === "pump" && !edit && stopTimer ? activePump : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    if (!pumpTimer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, pumpTimer]);

  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(2.5);
  const [unit, setUnit] = useState<MedicineUnit>("ml");
  // The catalogue entry picked from the chips (issue #49), or null for a
  // typed name. The catalogue is asked for THIS baby so lastDoseAt, and
  // the "next dose OK from" line built from it, is hers.
  const [medicineId, setMedicineId] = useState<string | null>(null);
  const catalogue = useMedicineCatalogue(babyId, open && kind === "medicine");
  const medicines = (catalogue.data ?? []).filter((m) => !m.archived);
  const pickMedicine = (entry: MedicineCatalogueEntry | null) => {
    setMedicineId(entry?.id ?? null);
    if (!entry) {
      setName("");
      return;
    }
    setName(entry.name);
    if (entry.defaultAmount != null) setAmount(entry.defaultAmount);
    if (entry.unit) setUnit(entry.unit);
  };
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [mtype, setMtype] = useState<MeasurementType>(initialMeasurementType);
  const [value, setValue] = useState(5);
  const [side, setSide] = useState<"left" | "right" | "both">("left");
  const [amountMl, setAmountMl] = useState(100);
  const [durationMin, setDurationMin] = useState(15);
  // A photo picked while creating a milestone (issue #48): uploaded right
  // after the row exists. Editing uploads straight away instead.
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const uploadPhoto = useUploadMilestonePhoto();
  const deletePhoto = useDeleteMilestonePhoto();
  // `edit` is the row as it was when tapped; after an upload or delete the
  // photos must come from the live list, or the sheet shows the old set
  // until it is reopened.
  const liveMilestones = useOtherList(
    "milestone",
    babyId,
    open && kind === "milestone" && !!edit,
  );
  const editPhotos =
    edit && edit.kind === "milestone"
      ? ((
          (liveMilestones.data ?? []) as {
            id: string;
            photos: MilestonePhoto[];
          }[]
        ).find((m) => m.id === edit.id)?.photos ?? edit.photos)
      : [];

  const lastMeasurement = (type: MeasurementType): number | null => {
    const rows = (recent.data ?? []) as { type?: string; value?: number }[];
    const row = rows.find((r) => r.type === type);
    return typeof row?.value === "number" ? row.value : null;
  };

  const instance = useSheetReset(open, () => {
    setNotes(edit && "notes" in edit ? (edit.notes ?? "") : "");
    setPendingPhoto(null);
    setTime(edit ? new Date(edit.time) : null);
    if (edit) {
      if (edit.kind === "medicine") {
        setName(edit.name);
        setAmount(edit.amount ?? 2.5);
        setUnit(edit.unit ?? "ml");
        setMedicineId(edit.medicineId);
      } else if (edit.kind === "note") {
        setContent(edit.content);
      } else if (edit.kind === "milestone") {
        setTitle(edit.title);
      } else if (edit.kind === "measurement") {
        setMtype(edit.type);
        setValue(edit.value);
      } else if (edit.kind === "pump") {
        setSide(edit.side ?? "left");
        setAmountMl(edit.amountMl ?? 100);
        setDurationMin(edit.durationMin ?? 15);
      }
    } else {
      // Prefill from the last entry of this kind (cached list; a cold first
      // open falls back to sensible defaults).
      const last = (recent.data ?? [])[0] as
        | Record<string, unknown>
        | undefined;
      if (kind === "medicine") {
        setName(typeof last?.name === "string" ? last.name : "");
        setAmount(typeof last?.amount === "number" ? last.amount : 2.5);
        setUnit(
          last?.unit === "mg" || last?.unit === "drops" || last?.unit === "dose"
            ? last.unit
            : "ml",
        );
        // Last-value prefill keeps the chip too, as long as the entry is
        // still in the catalogue and not archived.
        const lastId =
          typeof last?.medicineId === "string" ? last.medicineId : null;
        setMedicineId(
          lastId && medicines.some((m) => m.id === lastId) ? lastId : null,
        );
      }
      if (kind === "note") setContent("");
      if (kind === "milestone") setTitle("");
      if (kind === "measurement") {
        // Opening from the Home temperature card should land ON temperature:
        // the type is already known, so making the user re-pick it is a tap
        // spent restating something they just said.
        setMtype(initialMeasurementType);
        setValue(
          lastMeasurement(initialMeasurementType) ??
            measurementMeta[initialMeasurementType].fallback,
        );
      }
      if (kind === "pump") {
        setSide(
          pumpTimer?.runningSide ??
            (last?.side === "right" || last?.side === "both"
              ? last.side
              : "left"),
        );
        setAmountMl(typeof last?.amountMl === "number" ? last.amountMl : 100);
        // Stopping the timer: the clock is the duration (see liveDuration).
        setDurationMin(
          pumpTimer
            ? 0
            : typeof last?.durationMin === "number"
              ? last.durationMin
              : 15,
        );
      }
    }
  });

  const changeMtype = (type: MeasurementType) => {
    if (type === mtype) return;
    setMtype(type);
    // Always re-seed the value on a type switch — kg and cm scales are
    // disjoint, so carrying the old number over would store nonsense.
    setValue(lastMeasurement(type) ?? measurementMeta[type].fallback);
  };

  const createOther = useCreateOther();
  const updateOther = useUpdateOther();
  const deleteOther = useDeleteOther();

  // Never below what the clock has banked, never below the parent's own
  // number — the same rule as the feed sheet's steppers.
  const liveDuration = pumpTimer
    ? Math.max(durationMin, minutesFromSeconds(totalSeconds(pumpTimer, now)))
    : durationMin;

  const startPump = () => {
    startFeedTimer.mutate({
      babyId,
      kind: "pump",
      side,
      startTime: new Date().toISOString(),
    });
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const save = () => {
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    if (pumpTimer) {
      stopFeedTimer.mutate({
        id: pumpTimer.id,
        babyId,
        kind: "pump",
        amountMl,
        side,
        durationMin: liveDuration,
        ...(time ? { time: when } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
      if (!navigator.onLine) toast(t("Saved offline — will sync"));
      onOpenChange(false);
      return;
    }
    const fields: Record<string, unknown> =
      kind === "medicine"
        ? {
            name: name.trim(),
            amount,
            unit,
            // Create omits the link when there is none; PATCH must send
            // null to drop one the row already had.
            ...(medicineId ? { medicineId } : edit ? { medicineId: null } : {}),
          }
        : kind === "note"
          ? { content: content.trim() }
          : kind === "milestone"
            ? { title: title.trim() }
            : kind === "measurement"
              ? { type: mtype, value }
              : kind === "pump"
                ? { side, amountMl, durationMin }
                : {};

    if (edit) {
      updateOther.mutate({
        kind,
        id: edit.id,
        patch: { ...fields, time: when, notes: trimmedNotes || null },
      });
    } else if (kind === "milestone" && pendingPhoto) {
      // The photo needs the row's id, and a connection: the create is
      // queued offline like every log, but a File does not survive a reload,
      // so the upload is attempted once, now, and says so if it cannot.
      const file = pendingPhoto;
      const vars = {
        kind,
        babyId,
        time: when,
        ...fields,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      } as CreateOtherVars;
      if (!navigator.onLine) {
        toast(t("Saved offline — add the photo from the timeline later"));
        createOther.mutate(vars);
      } else {
        void createOther
          .mutateAsync(vars)
          .then((row) =>
            uploadPhoto.mutateAsync({ id: (row as { id: string }).id, file }),
          )
          .catch((err: Error) =>
            toast(
              `${t("Could not upload the photo")}: ${err.message}`,
              "error",
            ),
          );
      }
      onOpenChange(false);
      return;
    } else {
      createOther.mutate({
        kind,
        babyId,
        time: when,
        ...fields,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      } as CreateOtherVars);
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteOther.mutate({ kind, id: edit.id });
    onOpenChange(false);
  };

  const meta = otherKindMeta[kind];
  const mcfg = measurementScale(mtype, units);
  // A caution, never a block (CLAUDE.md: the parent is the authority): the
  // family's own interval added to the last dose, shown only while it is
  // still ahead. Editing an old dose has no "next" to speak of.
  const selectedMedicine = medicines.find((m) => m.id === medicineId) ?? null;
  const nextDose =
    !edit && selectedMedicine ? nextDoseFrom(selectedMedicine, now) : null;
  const saveDisabled =
    (kind === "medicine" && name.trim().length === 0) ||
    (kind === "note" && content.trim().length === 0) ||
    (kind === "milestone" && title.trim().length === 0);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t(`Edit ${meta.label.toLowerCase()}`) : t(meta.label)}
    >
      <div className="space-y-5 pb-4">
        {kind === "medicine" && (
          <>
            {medicines.length > 0 && (
              <ChipGroup
                options={[
                  ...medicines.map((m) => ({ value: m.id, label: m.name })),
                  { value: "__other", label: t("Other…") },
                ]}
                value={medicineId ?? "__other"}
                onChange={(v) =>
                  pickMedicine(
                    v === "__other"
                      ? null
                      : (medicines.find((m) => m.id === v) ?? null),
                  )
                }
              />
            )}
            {nextDose && (
              <p
                role="status"
                className="flex items-center gap-2 px-1 text-sm font-semibold text-caution"
              >
                <IconAlertTriangle className="h-4 w-4 shrink-0" />
                {t("Next dose OK from")} {formatClock(nextDose)}
              </p>
            )}
            {(!medicineId || medicines.length === 0) && (
              <Input
                placeholder={t("Medicine name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <ChipGroup
              options={[
                { value: "ml", label: "ml" },
                { value: "mg", label: "mg" },
                { value: "drops", label: t("drops") },
                { value: "dose", label: t("dose") },
              ]}
              value={unit}
              onChange={setUnit}
            />
            <Stepper
              value={amount}
              onChange={setAmount}
              step={unit === "mg" ? 50 : 0.5}
              decimals={unit === "mg" ? 0 : 1}
              min={0}
              max={unit === "mg" ? 1000 : 50}
              unit={unit}
            />
          </>
        )}

        {kind === "note" && (
          <textarea
            placeholder={t("What happened?")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            className="w-full rounded-xl2 border border-line bg-surface px-4 py-3 text-base text-ink placeholder:text-muted focus:ring-2 focus:ring-accent/40 focus:outline-none"
          />
        )}

        {kind === "milestone" && (
          <>
            <Input
              placeholder={t("Milestone (e.g. “First steps”)")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="space-y-2">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                {t("Photos")}
              </p>
              {editPhotos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {editPhotos.map((photo) => (
                    <div key={photo.id} className="relative">
                      <img
                        src={photoSrc(photo)}
                        alt={t("Photo")}
                        width={photo.width}
                        height={photo.height}
                        className="h-24 w-24 rounded-xl2 object-cover"
                      />
                      <button
                        type="button"
                        aria-label={t("Delete photo")}
                        onClick={() =>
                          deletePhoto.mutate(photo.id, {
                            onError: (err) => toast(err.message, "error"),
                          })
                        }
                        className="absolute -top-1.5 -right-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-sm active:bg-surface-2"
                      >
                        <IconTrash className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {pendingPhoto && (
                <p className="text-sm text-ink-soft">
                  {t("Photo ready")}: {pendingPhoto.name}
                </p>
              )}
              {(edit ? editPhotos.length < 3 : !pendingPhoto) && (
                <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink-soft active:scale-[0.97]">
                  <IconPhoto className="h-4 w-4" />
                  {uploadPhoto.isPending ? t("Uploading…") : t("Add photo")}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={uploadPhoto.isPending}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      if (edit) {
                        uploadPhoto.mutate(
                          { id: edit.id, file },
                          { onError: (err) => toast(err.message, "error") },
                        );
                      } else {
                        setPendingPhoto(file);
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </>
        )}

        {kind === "measurement" && (
          <>
            <ChipGroup
              options={[
                { value: "weight", label: t("Weight") },
                { value: "length", label: t("Length") },
                { value: "head", label: t("Head") },
                { value: "temperature", label: t("Temperature") },
              ]}
              value={mtype}
              onChange={changeMtype}
            />
            <Stepper
              value={mcfg.toDisplay(value)}
              onChange={(v) => setValue(mcfg.toCanonical(v))}
              step={mcfg.step}
              decimals={mcfg.decimals}
              min={mcfg.min}
              max={mcfg.max}
              unit={mcfg.unit}
            />
          </>
        )}

        {kind === "pump" && (
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
              value={amountMl}
              onChange={setAmountMl}
              step={10}
              min={0}
              max={500}
              unit="ml"
            />
            <Stepper
              value={liveDuration}
              onChange={setDurationMin}
              step={5}
              min={pumpTimer ? 0 : 5}
              max={90}
              unit="min"
            />
            {!edit && !pumpTimer && !activePump && (
              <Button
                variant="secondary"
                size="full"
                onClick={startPump}
                disabled={startFeedTimer.isPending}
              >
                {t("Start timer")}
              </Button>
            )}
            {!edit && !pumpTimer && activePump && (
              <p className="px-1 text-sm text-muted">
                {t("A pump timer is running — stop it from Home.")}
              </p>
            )}
          </>
        )}

        {kind !== "measurement" && (
          <TimeField key={instance} value={time} onChange={setTime} />
        )}

        {kind !== "note" && (
          <Input
            placeholder={t("Note (optional)")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}

        <Button
          size="full"
          onClick={save}
          disabled={
            saveDisabled || (!!pumpTimer && isOptimisticTimer(pumpTimer))
          }
        >
          {t("Save")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
