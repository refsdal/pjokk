import { useNavigate } from "@tanstack/react-router";
import { Fragment, useRef } from "react";
import type { Baby, Feature } from "@pjokk/shared";
import { Carousel } from "@/components/Carousel";
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

// One card per switch, then a summary (spec §The carousel). Every flip saves
// at once (optimistic on the babies list), so leaving mid-way keeps what was
// chosen; Done only navigates. The strip itself is the generic
// components/Carousel; this file only builds its steps.
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
  const track = useTracking(baby);
  const save = useSetBabyFeatures();
  const months = ageMonths(new Date(baby.birthDate));
  const controls = useRef<{ goTo: (i: number) => void } | null>(null);
  const last = featureCards.length; // the summary's index

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

  const steps = [
    ...featureCards.map((meta, i) => (
      <Fragment key={meta.key}>
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
                controls.current?.goTo(last);
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
      </Fragment>
    )),
    <section
      key="summary"
      className="flex flex-1 flex-col justify-center gap-4 px-4"
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
    </section>,
  ];

  return (
    <Carousel
      steps={steps}
      onFinish={() => void done()}
      testIdPrefix="tracking"
      controls={controls}
    />
  );
}
