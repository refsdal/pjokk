import {
  IconBath,
  IconLock,
  IconMilk,
  IconNote,
  IconPill,
  IconRuler,
  IconSparkles,
  IconVaccine,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type {
  MeasurementType,
  MedicineUnit,
  PlayType,
  TimelineEntry,
} from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCreateOther,
  useDeleteOther,
  useFamily,
  useOtherList,
  useUpdateOther,
  type CreateOtherVars,
  type OtherKind,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { playKindMeta, playTypeOrder } from "@/lib/play-ui";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Kinds gated behind Premium on the free plan (Task 1's server-side 402s).
// Medicine stays free.
const GATED_KINDS: ReadonlySet<OtherKind> = new Set([
  "bath",
  "note",
  "milestone",
  "measurement",
  "pump",
]);

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

const measurementConfig: Record<
  MeasurementType,
  {
    label: string;
    unit: string;
    step: number;
    min: number;
    max: number;
    fallback: number;
  }
> = {
  weight: {
    label: "Weight",
    unit: "kg",
    step: 0.1,
    min: 0.5,
    max: 40,
    fallback: 5,
  },
  length: {
    label: "Length",
    unit: "cm",
    step: 0.5,
    min: 30,
    max: 130,
    fallback: 60,
  },
  head: {
    label: "Head",
    unit: "cm",
    step: 0.5,
    min: 25,
    max: 60,
    fallback: 40,
  },
};

// The "More" picker: six activity types, one tap each.
export function MoreSheet({
  open,
  onOpenChange,
  onPick,
  onPickPlay,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (kind: OtherKind) => void;
  onPickPlay: (type: PlayType) => void;
}) {
  const navigate = useNavigate();
  const premium = (useFamily().data?.plan ?? "free") !== "free";

  // Play kinds are timed sessions with their own endpoints, so they sit
  // beside the generic kinds here rather than inside otherKindMeta.
  const tiles: {
    key: string;
    label: string;
    icon: TablerIcon;
    tint: string;
    locked: boolean;
    pick: () => void;
  }[] = [
    ...(Object.keys(otherKindMeta) as OtherKind[]).map((kind) => ({
      key: kind,
      ...otherKindMeta[kind],
      locked: !premium && GATED_KINDS.has(kind),
      pick: () => onPick(kind),
    })),
    ...playTypeOrder.map((type) => ({
      key: `play:${type}`,
      ...playKindMeta[type],
      locked: !premium,
      pick: () => onPickPlay(type),
    })),
    // Vaccines are free and open a screen, not a sheet — the programme
    // schedule needs more room than a tray.
    {
      key: "vaccines",
      label: "Vaccines",
      icon: IconVaccine,
      tint: "text-growth",
      locked: false,
      pick: () => {
        onOpenChange(false);
        void navigate({ to: "/vaccines" });
      },
    },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Log something")}>
      <div className="grid grid-cols-3 gap-3 pt-1 pb-6">
        {tiles.map(({ key, label, icon: Icon, tint, locked, pick }) => {
          return (
            <button
              key={key}
              type="button"
              onClick={
                locked
                  ? () => {
                      toast(t("Premium feature — upgrade in Settings"));
                      onOpenChange(false);
                      void navigate({ to: "/settings" });
                    }
                  : pick
              }
              className={cn(
                "flex h-24 flex-col items-center justify-center gap-2 rounded-xl2 border border-line bg-surface select-none active:scale-[0.97] active:bg-surface-2",
                locked && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "relative flex h-10 w-10 items-center justify-center rounded-full bg-surface-2",
                  locked ? "text-muted" : tint,
                )}
              >
                <Icon className="h-5 w-5" />
                {locked && (
                  <IconLock className="absolute -right-1 -bottom-1 h-4 w-4 rounded-full bg-surface p-0.5 text-muted" />
                )}
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  kind: OtherKind;
  edit?: OtherEntry | null;
}) {
  const recent = useOtherList(kind, babyId, open && !edit);

  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(2.5);
  const [unit, setUnit] = useState<MedicineUnit>("ml");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [mtype, setMtype] = useState<MeasurementType>("weight");
  const [value, setValue] = useState(5);
  const [side, setSide] = useState<"left" | "right" | "both">("left");
  const [amountMl, setAmountMl] = useState(100);
  const [durationMin, setDurationMin] = useState(15);
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  const lastMeasurement = (type: MeasurementType): number | null => {
    const rows = (recent.data ?? []) as { type?: string; value?: number }[];
    const row = rows.find((r) => r.type === type);
    return typeof row?.value === "number" ? row.value : null;
  };

  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit && "notes" in edit ? (edit.notes ?? "") : "");
    setTime(edit ? new Date(edit.time) : null);
    if (edit) {
      if (edit.kind === "medicine") {
        setName(edit.name);
        setAmount(edit.amount ?? 2.5);
        setUnit(edit.unit ?? "ml");
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
      }
      if (kind === "note") setContent("");
      if (kind === "milestone") setTitle("");
      if (kind === "measurement") {
        setMtype("weight");
        setValue(
          lastMeasurement("weight") ?? measurementConfig.weight.fallback,
        );
      }
      if (kind === "pump") {
        setSide(
          last?.side === "right" || last?.side === "both" ? last.side : "left",
        );
        setAmountMl(typeof last?.amountMl === "number" ? last.amountMl : 100);
        setDurationMin(
          typeof last?.durationMin === "number" ? last.durationMin : 15,
        );
      }
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const changeMtype = (type: MeasurementType) => {
    if (type === mtype) return;
    setMtype(type);
    // Always re-seed the value on a type switch — kg and cm scales are
    // disjoint, so carrying the old number over would store nonsense.
    setValue(lastMeasurement(type) ?? measurementConfig[type].fallback);
  };

  const createOther = useCreateOther();
  const updateOther = useUpdateOther();
  const deleteOther = useDeleteOther();

  const save = () => {
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    const fields: Record<string, unknown> =
      kind === "medicine"
        ? { name: name.trim(), amount, unit }
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
  const mcfg = measurementConfig[mtype];
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
            <Input
              placeholder={t("Medicine name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
          <Input
            placeholder={t("Milestone (e.g. “First steps”)")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}

        {kind === "measurement" && (
          <>
            <ChipGroup
              options={[
                { value: "weight", label: t("Weight") },
                { value: "length", label: t("Length") },
                { value: "head", label: t("Head") },
              ]}
              value={mtype}
              onChange={changeMtype}
            />
            <Stepper
              value={value}
              onChange={setValue}
              step={mcfg.step}
              decimals={1}
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
              value={durationMin}
              onChange={setDurationMin}
              step={5}
              min={5}
              max={90}
              unit="min"
            />
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

        <Button size="full" onClick={save} disabled={saveDisabled}>
          {t("Save")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
