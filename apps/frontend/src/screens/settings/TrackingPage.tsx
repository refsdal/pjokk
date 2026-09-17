import { Link } from "@tanstack/react-router";
import { TrackingCarousel } from "@/components/tracking/TrackingCarousel";
import { useBabies, useMe } from "@/lib/data";
import { t } from "@/lib/i18n";

// Settings → <baby> → What to track, and the step right after adding a
// baby (?new=1 makes Done go to Home). The whole screen is the carousel:
// no settings chrome, because a card needs the height.
export function TrackingPage({
  babyId,
  isNew,
}: {
  babyId: string;
  isNew: boolean;
}) {
  const me = useMe();
  const babies = useBabies();
  const role = me.data?.memberRole;
  const isAdmin = role === "admin" || role === "owner";
  const baby = babies.data?.find((b) => b.id === babyId);
  if (!baby) {
    return babies.isPending ? null : (
      <p className="p-6 text-sm text-muted">
        {t("Page not found")}{" "}
        <Link to="/settings" className="font-semibold text-accent">
          {t("Back")}
        </Link>
      </p>
    );
  }
  return <TrackingCarousel baby={baby} isAdmin={isAdmin} isNew={isNew} />;
}
