import { IconMapPin, IconPhone } from "@tabler/icons-react";
import { CaretakerChips } from "@/components/CaretakerChips";
import { useSetPickupOverride, useSummary } from "@/lib/data";
import { directionsUrl, minuteClock, pickupToday } from "@/lib/daycare-ui";
import { t } from "@/lib/i18n";
import { toLocalDateInput } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

const linkClass = cn(
  "flex h-11 flex-1 items-center justify-center gap-2 rounded-xl2 border border-line bg-surface text-sm font-semibold text-ink active:bg-surface-2",
  focusRing,
);

// The barnehage on the day sheet (spec 2026-09-17-daycare-place-and-
// pickup-plan-design.md): where it is and how to reach it, and who collects
// her TODAY. The chips start on the plan's person; tapping someone else is
// the one-day exception, saved at once — it is about today, not about the
// day being edited — and tapping the plan's own person hands the day back
// to the grid. Any member may. Renders nothing for a family that has set up
// neither a place nor a plan.
export function DaycarePlaceBlock({ babyId }: { babyId: string }) {
  const summary = useSummary(babyId);
  const setOverride = useSetPickupOverride();
  const today = summary.data?.daycare ?? null;
  if (!today) return null;

  const { place } = today;
  const pickup = pickupToday(today.plan);
  const directions = place ? directionsUrl(place) : null;
  const hours =
    place && place.openMinute !== null && place.closeMinute !== null
      ? `${minuteClock(place.openMinute)}–${minuteClock(place.closeMinute)}`
      : place?.closeMinute != null
        ? `${t("Closes")} ${minuteClock(place.closeMinute)}`
        : null;

  return (
    <div className="space-y-3" data-testid="daycare-place-block">
      {place && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-ink">
            {place.name}
            {hours && (
              <span className="ml-2 font-medium text-ink-soft tabular-nums">
                {hours}
              </span>
            )}
          </p>
          {(place.phone || directions) && (
            <div className="flex gap-2">
              {place.phone && (
                <a
                  href={`tel:${place.phone.replace(/\s+/g, "")}`}
                  className={linkClass}
                >
                  <IconPhone className="h-4 w-4 text-accent" />
                  {t("Call")}
                </a>
              )}
              {directions && (
                <a
                  href={directions}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                >
                  <IconMapPin className="h-4 w-4 text-accent" />
                  {t("Directions")}
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {pickup?.minute != null && (
        <p
          className="text-sm text-ink-soft tabular-nums"
          data-testid="pickup-expected"
        >
          {t("Pick-up")} {minuteClock(pickup.minute)}
        </p>
      )}
      <CaretakerChips
        label="Collecting today"
        testId="collecting-chips"
        choice={{
          value: pickup?.userId ?? null,
          // The chips only ever hand over an id (the type is a state
          // setter's, which could be a function).
          choose: (userId) => {
            if (typeof userId !== "string") return;
            setOverride.mutate({
              babyId,
              date: toLocalDateInput(),
              userId: userId === pickup?.plannedUserId ? null : userId,
            });
          },
        }}
      />
    </div>
  );
}
