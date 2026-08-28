import type { Icon as TablerIcon } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// The 2×2 grid of big log buttons: the whole point of the home screen.
export function LogButton({
  icon: Icon,
  label,
  tintClass,
  onClick,
  disabled,
}: {
  icon: TablerIcon;
  label: string;
  tintClass: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-28 flex-col items-center justify-center gap-2 rounded-xl2 border border-line bg-surface select-none active:scale-[0.97] active:bg-surface-2 disabled:opacity-40",
      )}
    >
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full bg-surface-2",
          tintClass,
        )}
      >
        <Icon className="h-6 w-6" />
      </span>
      <span className="text-base font-bold text-ink">{label}</span>
    </button>
  );
}
