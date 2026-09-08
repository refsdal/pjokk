import type { Icon as TablerIcon } from "@tabler/icons-react";
import { cn, focusRing } from "@/lib/utils";

// The big log buttons: the whole point of the home screen. h-28 on the
// phone; h-32 with a bigger disc and label from md up (spec §4) — big
// screens get bigger targets, not more of them.
export function LogButton({
  icon: Icon,
  label,
  tintClass,
  onClick,
  disabled,
  className,
}: {
  icon: TablerIcon;
  label: string;
  tintClass: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-28 flex-col items-center justify-center gap-2 rounded-xl2 border border-line bg-surface select-none active:scale-[0.97] active:bg-surface-2 disabled:opacity-40 md:h-32",
        focusRing,
        className,
      )}
    >
      <span
        className={cn(
          "flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 md:h-14 md:w-14",
          tintClass,
        )}
      >
        <Icon className="h-6 w-6 md:h-7 md:w-7" />
      </span>
      <span className="text-base font-bold text-ink md:text-lg">{label}</span>
    </button>
  );
}
