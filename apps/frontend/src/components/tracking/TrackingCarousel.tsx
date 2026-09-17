import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { Baby, Feature } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSetBabyFeatures } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatAge } from "@/lib/time";
import {
  ageMonths,
  featureCards,
  recommended,
  recommendedByAge,
  useTracking,
} from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { TrackingCard } from "./TrackingCard";

// One card per switch, then a summary (spec §The carousel). A scroll-snap
// strip with Back / Next as the primary control — the app's no-swipe rule
// is about ROUTE navigation fighting the back gesture; swiping here is a
// bonus nobody needs. Every flip saves at once (optimistic on the babies
// list), so leaving mid-way keeps what was chosen; Done only navigates.
export function TrackingCarousel({
  baby,
  isAdmin,
  isNew,
}: {
  baby: Baby;
  isAdmin: boolean;
  isNew: boolean;
}) {
  const navigate = useNavigate();
  const strip = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const track = useTracking(baby);
  const save = useSetBabyFeatures();
  const months = ageMonths(new Date(baby.birthDate));
  const last = featureCards.length; // the summary's index

  const goTo = (i: number) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setIndex(i);
  };
  const onScroll = () => {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return;
    setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };
  const set = (features: Feature[]) =>
    save.mutate({ babyId: baby.id, features });
  const flip = (key: Feature, on: boolean) =>
    set(on ? [...baby.features, key] : baby.features.filter((k) => k !== key));
  const done = () =>
    isNew
      ? navigate({ to: "/home" })
      : navigate({
          to: "/settings/baby/$babyId",
          params: { babyId: baby.id },
        });

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col pt-safe md:max-w-lg">
      <div
        ref={strip}
        onScroll={onScroll}
        // overflow-y-hidden: a scroll container clips its box-shadows, so
        // the light-up ring must stay inside the strip and the strip must
        // never scroll vertically (which would push the ring to the edge).
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
        data-testid="tracking-strip"
      >
        {featureCards.map((meta, i) => (
          <div
            key={meta.key}
            className="flex w-full shrink-0 snap-center flex-col"
          >
            {i === 0 && isNew && isAdmin && (
              <Card className="mx-4 mt-4 space-y-3 text-center">
                <p className="text-sm text-ink-soft">
                  {t(
                    "Swipe through what Pjokk can track, or take the set we suggest for a baby of",
                  )}{" "}
                  {formatAge(new Date(baby.birthDate))}.
                </p>
                <Button
                  size="full"
                  onClick={() => {
                    set(recommended(months));
                    goTo(last);
                  }}
                  data-testid="use-recommended"
                >
                  {t("Use the recommended set")}
                </Button>
              </Card>
            )}
            <TrackingCard
              meta={meta}
              on={track.has(meta.key)}
              tag={
                meta.key === "daycare"
                  ? `${t("Recommended if")} ${baby.name} ${t("goes to barnehage")}`
                  : recommendedByAge(meta.key, months)
                    ? `${t("Recommended at")} ${baby.name}${t("'s age")}`
                    : null
              }
              readOnly={!isAdmin}
              onToggle={(on) => flip(meta.key, on)}
            />
          </div>
        ))}
        <section
          className="flex w-full shrink-0 snap-center flex-col justify-center gap-4 px-4"
          data-testid="tracking-summary"
          aria-label={t("Summary")}
        >
          <h2 className="text-2xl font-extrabold text-ink">
            {t("Tracking for")} {baby.name}
          </h2>
          {track.any ? (
            <ul className="space-y-2">
              {featureCards
                .filter((m) => track.has(m.key))
                .map((m) => {
                  const Icon = m.icon;
                  return (
                    <li
                      key={m.key}
                      className="flex items-center gap-2 font-semibold text-ink"
                    >
                      <Icon className={cn("h-5 w-5", m.tint)} />
                      {t(m.label)}
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p className="text-ink-soft">{t("Nothing tracked yet")}</p>
          )}
          <p className="text-sm text-muted">
            {t("Change this any time under Settings.")}
          </p>
        </section>
      </div>
      {/* pb-tabbar clears the bottom bar on the phone (styles.css). */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-tabbar">
        <Button
          variant="outline"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
        >
          {t("Back")}
        </Button>
        <div className="flex gap-1" aria-hidden>
          {Array.from({ length: last + 1 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed strip of dots
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                i === index ? "bg-accent" : "bg-line",
              )}
            />
          ))}
        </div>
        {index < last ? (
          <Button onClick={() => goTo(index + 1)} data-testid="tracking-next">
            {t("Next")}
          </Button>
        ) : (
          <Button onClick={() => void done()} data-testid="tracking-done">
            {t("Done")}
          </Button>
        )}
      </div>
    </div>
  );
}
