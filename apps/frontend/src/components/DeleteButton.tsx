import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

// Two-tap delete: no modal, no accidental loss.
export function DeleteButton({
  onDelete,
  label,
  disabled,
}: {
  onDelete: () => void;
  label?: string;
  // For deletes a caller can already tell will be refused — the operator
  // console's last-admin guard. Disabled rather than hidden: the control
  // should be visibly present and visibly unavailable, with the reason
  // stated beside it.
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      size="full"
      variant={armed ? "danger" : "ghost"}
      className={armed ? "" : "text-danger"}
      disabled={disabled}
      onClick={() => {
        if (armed) onDelete();
        else setArmed(true);
      }}
    >
      {armed ? t("Tap again to confirm") : (label ?? t("Delete"))}
    </Button>
  );
}
