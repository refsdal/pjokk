import { IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { DaycareLog } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { daycareMeta } from "@/lib/daycare-ui";
import { dismissHandover, handoverDismissed } from "@/lib/handover-ui";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

// "How was the day?" (issue #106): offered on Home once she has been picked
// up, until someone answers or waves it away. A question, not an alarm: a
// hairline card like the barnehage banner it replaces. The server decides
// whether a handover is due (Summary.handoverDue); the dismissal is this
// device's alone, because "not now" on a phone in the cloakroom should not
// silence the other parent's.
export function HandoverCard({
  day,
  onAdd,
}: {
  day: DaycareLog;
  onAdd: (day: DaycareLog) => void;
}) {
  const [dismissed, setDismissed] = useState(() => handoverDismissed(day.id));
  if (dismissed || handoverDismissed(day.id)) return null;
  const Icon = daycareMeta.icon;
  return (
    <div className="flex items-center gap-3 rounded-xl2 border border-line bg-surface p-4">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2",
          daycareMeta.tint,
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold text-ink">
          {t("How was the day at daycare?")}
        </p>
        <p className="truncate text-xs text-muted">
          {t("Nap, meals and diapers, as the staff told it")}
        </p>
      </div>
      <Button variant="secondary" onClick={() => onAdd(day)}>
        {t("Add")}
      </Button>
      <button
        type="button"
        aria-label={t("Dismiss")}
        onClick={() => {
          dismissHandover(day.id);
          setDismissed(true);
        }}
        className={cn(
          "-mr-2 flex h-11 w-8 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2",
          focusRing,
        )}
      >
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
}
