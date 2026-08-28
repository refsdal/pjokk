import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { t } from "@/lib/i18n";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";

// Retroactive logging is the norm (CLAUDE.md §4): every time field offers
// Now / 15 m ago / Pick time. Value is a Date; "Now" means save-time now
// (resolved by the parent at submit).

type Preset = "now" | "15m" | "pick";
type DayChoice = "today" | "yesterday" | "other";

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function dayChoiceFor(d: Date): DayChoice {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return "other";
}

const setDatePart = (base: Date, dayChoice: DayChoice, otherDate?: string) => {
  const d = new Date(base);
  const ref = new Date();
  if (dayChoice === "yesterday") ref.setDate(ref.getDate() - 1);
  if (dayChoice === "other" && otherDate) {
    const [y, m, dd] = otherDate.split("-").map(Number);
    ref.setFullYear(y!, m! - 1, dd!);
  }
  d.setFullYear(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return d;
};

// Retroactive logging never needs the future — clamping here (rather than
// relying on the date/time inputs' max attr, which only reliably blocks
// future *dates*, not future *clock times* on today) keeps every composed
// moment sane.
const clampFuture = (d: Date) => (d.getTime() > Date.now() ? new Date() : d);

export function TimeField({
  value,
  onChange,
  className,
}: {
  /** null = "now at submit time" */
  value: Date | null;
  onChange: (v: Date | null) => void;
  className?: string;
}) {
  const [preset, setPreset] = useState<Preset>(value ? "pick" : "now");
  const [day, setDay] = useState<DayChoice>(() =>
    dayChoiceFor(value ?? new Date()),
  );

  const choose = (p: Preset) => {
    setPreset(p);
    if (p === "now") onChange(null);
    if (p === "15m") onChange(new Date(Date.now() - 15 * 60_000));
    if (p === "pick") {
      const base = value ?? new Date();
      setDay(dayChoiceFor(base));
      onChange(base);
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <ChipGroup
        options={[
          { value: "now", label: t("Now") },
          { value: "15m", label: t("15 m ago") },
          { value: "pick", label: t("Pick time") },
        ]}
        value={preset}
        onChange={choose}
      />
      {preset === "15m" && value && (
        <p className="px-1 text-sm text-muted">{formatClock(value)}</p>
      )}
      {preset === "pick" && (
        <div className="space-y-2">
          <ChipGroup
            options={[
              { value: "today", label: t("Today") },
              { value: "yesterday", label: t("Yesterday") },
              { value: "other", label: t("Other day") },
            ]}
            value={day}
            onChange={(d) => {
              setDay(d);
              if (d !== "other")
                onChange(clampFuture(setDatePart(value ?? new Date(), d)));
            }}
          />
          {day === "other" && (
            <input
              type="date"
              value={toDateInput(value ?? new Date())}
              max={toDateInput(new Date())}
              onChange={(e) =>
                e.target.value &&
                onChange(
                  clampFuture(
                    setDatePart(value ?? new Date(), "other", e.target.value),
                  ),
                )
              }
              className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
            />
          )}
          <input
            type="time"
            value={toTimeInput(value ?? new Date())}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              const d = new Date(value ?? new Date());
              d.setHours(h ?? 0, m ?? 0, 0, 0);
              onChange(clampFuture(d));
            }}
            className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
          />
        </div>
      )}
    </div>
  );
}
