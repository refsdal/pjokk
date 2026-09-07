import { useState } from "react";
import type { Baby } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ReminderKind,
  type ReminderMode,
  useCreateReminder,
} from "@/lib/data/reminders";
import { t } from "@/lib/i18n";
import { nightSchedule } from "@/lib/night";
import {
  DAYS_ALL,
  DAYS_WEEKDAYS,
  DAYS_WEEKENDS,
  deviceTimeZone,
  intervalLabel,
  intervalOptions,
  kindLabel,
  parseMinuteOfDay,
  quietLabel,
} from "@/lib/reminder-ui";
import { toast } from "@/lib/toast";

// Add a reminder (issue #45). Chips, not forms: kind, then "after a gap" or
// "at a time", then the one number that mode needs. The only keyboard is
// the custom label (and the medicine name, optional). Quiet hours are one
// toggle prefilled from the device's night-mode schedule — the window a
// parent already told the app they sleep in.
export function ReminderSheet({
  open,
  onOpenChange,
  babies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babies: Baby[];
}) {
  const schedule = nightSchedule();
  const [kind, setKind] = useState<ReminderKind>("feed");
  const [mode, setMode] = useState<ReminderMode>("since_last");
  const [intervalMin, setIntervalMin] = useState<number>(180);
  const [atTime, setAtTime] = useState("09:00");
  const [days, setDays] = useState<number>(DAYS_ALL);
  const [quiet, setQuiet] = useState(true);
  const [babyId, setBabyId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [wasOpen, setWasOpen] = useState(false);

  if (open && !wasOpen) {
    setWasOpen(true);
    setKind("feed");
    setMode("since_last");
    setIntervalMin(180);
    setAtTime("09:00");
    setDays(DAYS_ALL);
    setQuiet(true);
    setBabyId(null);
    setLabel("");
  }
  if (!open && wasOpen) setWasOpen(false);

  const create = useCreateReminder();

  const changeKind = (k: ReminderKind) => {
    setKind(k);
    // A custom reminder has nothing to be "since".
    if (k === "custom") setMode("at_time");
  };

  const atMinute = parseMinuteOfDay(atTime);
  const trimmedLabel = label.trim();
  const canSave =
    (mode === "since_last" || atMinute != null) &&
    (kind !== "custom" || trimmedLabel.length > 0) &&
    !create.isPending;

  const save = () => {
    if (!canSave) return;
    create.mutate(
      {
        kind,
        mode,
        tz: deviceTimeZone(),
        days,
        ...(mode === "since_last" ? { intervalMin } : { atMinute: atMinute! }),
        ...(quiet
          ? { quietStart: schedule.startHour, quietEnd: schedule.endHour }
          : {}),
        ...(babyId ? { babyId } : {}),
        ...(trimmedLabel ? { label: trimmedLabel } : {}),
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => toast(err.message, "error"),
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Add reminder")}>
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={(
            ["feed", "diaper", "pump", "medicine", "custom"] as ReminderKind[]
          ).map((k) => ({ value: k, label: t(kindLabel[k]) }))}
          value={kind}
          onChange={changeKind}
        />

        {(kind === "custom" || kind === "medicine") && (
          <Input
            placeholder={
              kind === "custom"
                ? t("What to remind about")
                : t("Medicine name (optional)")
            }
            value={label}
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}

        {kind !== "custom" && (
          <ChipGroup
            options={[
              { value: "since_last", label: t("After a gap") },
              { value: "at_time", label: t("At a time") },
            ]}
            value={mode}
            onChange={setMode}
          />
        )}

        {mode === "since_last" ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("When nothing is logged for")}
            </p>
            <ChipGroup
              options={intervalOptions.map((m) => ({
                value: String(m),
                label: intervalLabel(m),
              }))}
              value={String(intervalMin)}
              onChange={(v) => setIntervalMin(Number(v))}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted uppercase">
              {t("At")}
            </p>
            <Input
              type="time"
              aria-label={t("Time")}
              value={atTime}
              onChange={(e) => setAtTime(e.target.value)}
            />
            <ChipGroup
              options={[
                { value: String(DAYS_ALL), label: t("Every day") },
                { value: String(DAYS_WEEKDAYS), label: t("Weekdays") },
                { value: String(DAYS_WEEKENDS), label: t("Weekends") },
              ]}
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
            />
          </div>
        )}

        {babies.length > 1 && (
          <ChipGroup
            options={[
              { value: "", label: t("Any baby") },
              ...babies.map((b) => ({ value: b.id, label: b.name })),
            ]}
            value={babyId ?? ""}
            onChange={(v) => setBabyId(v || null)}
          />
        )}

        <ChipGroup
          options={[
            {
              value: "quiet",
              label: quietLabel(schedule.startHour, schedule.endHour),
            },
          ]}
          value={quiet ? "quiet" : null}
          onChange={() => setQuiet((q) => !q)}
        />

        <Button size="full" onClick={save} disabled={!canSave}>
          {t("Add reminder")}
        </Button>
      </div>
    </Sheet>
  );
}
