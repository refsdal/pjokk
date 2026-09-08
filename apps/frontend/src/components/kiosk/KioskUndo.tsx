import { IconCheck } from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

export const UNDO_MS = 6000;

// The undo toast (spec §4): the kiosk's own — it needs a button and a
// longer life than lib/toast.ts gives.
export function KioskUndo({
  text,
  onUndo,
}: {
  text: string;
  onUndo: () => void;
}) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex items-center gap-4 rounded-full bg-ink py-3 pr-3 pl-5 text-base font-semibold text-bg shadow-lg">
        <IconCheck className="h-5 w-5 text-accent" />
        {text}
        <button
          type="button"
          onClick={onUndo}
          className={cn(
            "flex h-10 items-center rounded-full bg-black/20 px-4 font-extrabold",
            focusRing,
          )}
        >
          {t("Undo")}
        </button>
      </div>
    </div>
  );
}
