import { useState } from "react";
import { ChipGroup } from "@/components/Chips";
import { t } from "@/lib/i18n";
import { formatClock } from "@/lib/time";
import { cn } from "@/lib/utils";

// Retroactive logging is the norm (CLAUDE.md §4): every time field offers
// Now / 15 m ago / Pick time. Value is a Date; "Now" means save-time now
// (resolved by the parent at submit).

type Preset = "now" | "15m" | "pick";

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

  const choose = (p: Preset) => {
    setPreset(p);
    if (p === "now") onChange(null);
    if (p === "15m") onChange(new Date(Date.now() - 15 * 60_000));
    if (p === "pick") onChange(value ?? new Date());
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
        <input
          type="datetime-local"
          value={toLocalInputValue(value ?? new Date())}
          max={toLocalInputValue(new Date())}
          onChange={(e) => {
            const d = new Date(e.target.value);
            if (!Number.isNaN(d.getTime())) onChange(d);
          }}
          className="h-12 w-full rounded-xl2 border border-line bg-surface px-4 text-base text-ink"
        />
      )}
    </div>
  );
}
