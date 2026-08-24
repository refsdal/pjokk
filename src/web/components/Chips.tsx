import { cn } from "@/lib/utils";

// Chip groups replace dropdowns everywhere (CLAUDE.md §5): one tap, no
// keyboard, big targets.
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)} role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-11 min-w-16 rounded-full border px-4 text-sm font-semibold transition-colors select-none active:scale-[0.97]",
            value === opt.value
              ? "border-accent bg-accent text-white"
              : "border-line bg-surface text-ink-soft",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
