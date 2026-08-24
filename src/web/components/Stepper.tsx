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
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit: string;
  className?: string;
}) {
  const adjust = (delta: number) =>
    onChange(Math.min(max, Math.max(min, value + delta)));
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
        <span className="text-2xl font-bold">{value}</span>
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
