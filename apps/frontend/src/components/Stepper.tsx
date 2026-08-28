import { IconMinus, IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Number stepper: amounts change by taps — but the number itself is a real
// input, so a big jump can be typed directly (numeric keypad, clamped).
export function Stepper({
  value,
  onChange,
  step = 10,
  min = 0,
  max = 500,
  unit,
  decimals = 0,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  /** Fixed step, or a function of (current value, direction) — e.g. feeds
   *  step 5 ml below 50 and 10 ml above. */
  step?: number | ((value: number, direction: 1 | -1) => number);
  min?: number;
  max?: number;
  unit: string;
  decimals?: number;
  className?: string;
}) {
  const factor = 10 ** decimals;
  const clamp = (v: number) =>
    Math.min(max, Math.max(min, Math.round(v * factor) / factor));
  const stepFor = (dir: 1 | -1) =>
    typeof step === "function" ? step(value, dir) : step;
  const adjust = (dir: 1 | -1) => onChange(clamp(value + dir * stepFor(dir)));

  // Draft mirrors the value while typing; commit on blur/Enter.
  const [draft, setDraft] = useState<string | null>(null);
  const shown =
    draft ?? (decimals > 0 ? value.toFixed(decimals) : String(value));
  useEffect(() => {
    setDraft(null);
  }, [value]);
  const commit = () => {
    if (draft !== null && draft.trim() !== "") {
      const parsed = Number(draft.replace(",", "."));
      if (Number.isFinite(parsed)) onChange(clamp(parsed));
    }
    setDraft(null);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl2 border border-line bg-surface p-1.5",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`${t("decrease")} ${unit}`}
        onClick={() => adjust(-1)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <IconMinus className="h-5 w-5" />
      </button>
      <div className="flex items-baseline justify-center tabular-nums">
        <input
          inputMode="decimal"
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label={unit}
          size={Math.max(shown.length, 1)}
          className="w-auto min-w-8 border-none bg-transparent p-0 text-center text-2xl font-bold text-ink outline-none"
          style={{ width: `${Math.max(shown.length, 1)}ch` }}
        />
        <span className="ml-1 text-sm text-muted">{unit}</span>
      </div>
      <button
        type="button"
        aria-label={`${t("increase")} ${unit}`}
        onClick={() => adjust(1)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <IconPlus className="h-5 w-5" />
      </button>
    </div>
  );
}
