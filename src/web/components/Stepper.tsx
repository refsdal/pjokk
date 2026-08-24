import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// Number stepper: amounts change by taps, never by the OS keyboard.
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
  step?: number;
  min?: number;
  max?: number;
  unit: string;
  decimals?: number;
  className?: string;
}) {
  const factor = 10 ** decimals;
  const adjust = (delta: number) =>
    onChange(
      Math.min(
        max,
        Math.max(min, Math.round((value + delta) * factor) / factor),
      ),
    );
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl2 border border-line bg-surface p-1.5",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`decrease by ${step}`}
        onClick={() => adjust(-step)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <Minus className="h-5 w-5" />
      </button>
      <div className="text-center tabular-nums">
        <span className="text-2xl font-bold">
          {decimals > 0 ? value.toFixed(decimals) : value}
        </span>
        <span className="ml-1 text-sm text-muted">{unit}</span>
      </div>
      <button
        type="button"
        aria-label={`increase by ${step}`}
        onClick={() => adjust(step)}
        className="flex h-12 w-14 items-center justify-center rounded-xl bg-surface-2 text-ink active:scale-95"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  );
}
