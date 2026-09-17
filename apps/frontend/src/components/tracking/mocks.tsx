import type { ReactNode } from "react";
import type { Feature } from "@pjokk/shared";
import { StatusCard } from "@/components/StatusCard";
import { Card } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import { featureMeta } from "@/lib/tracking";
import { cn } from "@/lib/utils";

// The card's illustration is the feature itself (spec §The mocks): the
// Feeds card shows the status card a family will see on Home, the Sleep
// card the sleeping banner's line, and so on. Real components where one
// fits, a Card in the same idiom where none does; one CSS animation each
// (styles.css .tracking-anim), played once when the switch lights up.
// Nothing here is data: the numbers are what a Tuesday looks like.

function Row({
  feature,
  on,
  headline,
  detail,
  children,
}: {
  feature: Feature;
  on: boolean;
  headline: string;
  detail: string;
  children?: ReactNode;
}) {
  const meta = featureMeta(feature);
  const Icon = meta.icon;
  return (
    <Card className="tracking-mock flex items-center gap-3" data-on={on}>
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2",
          meta.tint,
        )}
      >
        <Icon className="tracking-anim h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold text-ink">{headline}</span>
        <span className="block truncate text-xs text-muted">{detail}</span>
      </span>
      {children}
    </Card>
  );
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export function FeatureMock({
  feature,
  on,
}: {
  feature: Feature;
  on: boolean;
}) {
  switch (feature) {
    case "feeds":
      return (
        <div className="tracking-mock tracking-anim" data-on={on}>
          <StatusCard
            icon={featureMeta("feeds").icon}
            label={t("Last feed")}
            time={minutesAgo(80)}
            detail={`120 ml · ${t("bottle")}`}
            sub={`6 ${t("feeds")} · 540 ml ${t("today")}`}
            tintClass="text-feed"
          />
        </div>
      );
    case "diapers":
      return (
        <div className="tracking-mock tracking-anim" data-on={on}>
          <StatusCard
            icon={featureMeta("diapers").icon}
            label={t("Last diaper")}
            time={minutesAgo(35)}
            detail={t("wet")}
            sub={`3 ${t("wet")} · 1 ${t("dirty")} · 1 ${t("both")}`}
            tintClass="text-diaper"
          />
        </div>
      );
    case "sleep":
      return (
        <Row
          feature="sleep"
          on={on}
          headline={`${t("Sleeping")} · 42 min`}
          detail={t("Tap Wake when she is up")}
        />
      );
    case "pump":
      return (
        <Row
          feature="pump"
          on={on}
          headline={`${t("Pumping")} · 12:40`}
          detail={`90 ml ${t("today")}`}
        />
      );
    case "medicine":
      return (
        <Row
          feature="medicine"
          on={on}
          headline="Paracet 2,5 ml"
          detail={`${t("Next dose OK from")} 16:30`}
        />
      );
    case "measurements":
      return (
        <Row
          feature="measurements"
          on={on}
          headline="5,4 kg"
          detail={`${t("~")}50${t(". percentile (WHO)")}`}
        />
      );
    case "milestones":
      return (
        <Row
          feature="milestones"
          on={on}
          headline={t("First smile")}
          detail={t("with a photo")}
        />
      );
    case "bath":
      return (
        <Row
          feature="bath"
          on={on}
          headline={t("Bath")}
          detail={t("yesterday")}
        />
      );
    case "notes":
      return (
        <Row
          feature="notes"
          on={on}
          headline={t("Slept in the pram")}
          detail="14:05"
        />
      );
    case "play":
      return (
        <Row
          feature="play"
          on={on}
          headline={`${t("Tummy time")} · 8 min`}
          detail={t("still going")}
        />
      );
    case "daycare":
      return (
        <Row
          feature="daycare"
          on={on}
          headline={t("At daycare")}
          detail={`${t("Pick-up")} 15:30 · Anne`}
        />
      );
    case "illness":
      return (
        <Row
          feature="illness"
          on={on}
          headline={t("Ill since Monday")}
          detail={`48 ${t("h")} ${t("symptom-free by")} 09:00`}
        />
      );
    case "vaccines":
      return (
        <Row
          feature="vaccines"
          on={on}
          headline={`3 ${t("months")}: Rotavirus`}
          detail={t("due this week")}
        />
      );
  }
}
