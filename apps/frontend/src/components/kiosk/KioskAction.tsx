import { cn, focusRing } from "@/lib/utils";

// A quick action inside a card (spec §4): 56 px, one tap logs.
export function KioskAction({
  label,
  hint,
  primary = false,
  disabled = false,
  onClick,
}: {
  label: string;
  hint?: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-14 min-w-0 flex-1 flex-col items-center justify-center rounded-2xl border px-2 text-base font-bold whitespace-nowrap select-none active:scale-[0.97] disabled:opacity-40",
        primary
          ? "border-accent bg-accent text-on-accent"
          : "border-line bg-surface-2 text-ink",
        focusRing,
      )}
    >
      <span className="max-w-full truncate">{label}</span>
      {hint && (
        <span className="max-w-full truncate text-xs font-medium opacity-75">
          {hint}
        </span>
      )}
    </button>
  );
}
