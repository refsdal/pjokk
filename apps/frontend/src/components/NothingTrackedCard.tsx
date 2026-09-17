import { Link } from "@tanstack/react-router";
import type { Baby } from "@pjokk/shared";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";

// Home for a baby with an empty set (spec
// docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): a
// brand-new baby whose carousel was abandoned, or a family that switched
// everything off. An admin gets the door; a member gets the fact.
export function NothingTrackedCard({
  baby,
  isAdmin,
}: {
  baby: Baby;
  isAdmin: boolean;
}) {
  return (
    <Card className="space-y-3 text-center" data-testid="nothing-tracked">
      <p className="text-base font-bold text-ink">
        {isAdmin
          ? `${t("Choose what to track for")} ${baby.name}`
          : `${t("Nothing is tracked for")} ${baby.name} ${t("yet")}`}
      </p>
      {isAdmin && (
        <Link
          to="/settings/baby/$babyId/tracking"
          params={{ babyId: baby.id }}
          className="inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 font-bold text-on-accent"
        >
          {t("What to track")}
        </Link>
      )}
    </Card>
  );
}
