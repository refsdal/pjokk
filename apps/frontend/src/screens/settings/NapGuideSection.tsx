import type { Baby } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usualNapSuggestion } from "@/lib/about-me";
import { useRecentSleeps, useSetUsualNap, useSummary } from "@/lib/data";
import { t } from "@/lib/i18n";
import { setNapGuide, useNapGuide } from "@/lib/nap-window";
import { SectionTitle } from "./lib";

const pad = (n: number) => String(n).padStart(2, "0");
const toClock = (minute: number) =>
  `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;

// The nap-window guide's one switch (issue #46), with the one-line
// disclaimer the feature owes: it is a typical-for-her-age guide from a
// cited table, not advice, and tired signs beat any table. THIS DEVICE's
// switch, so it lives with the personal settings on /profile.
export function NapGuideSection() {
  const enabled = useNapGuide();
  return (
    <>
      <SectionTitle>{t("Nap window")}</SectionTitle>
      <Card className="space-y-3">
        <ChipGroup
          options={[
            { value: "on", label: t("On") },
            { value: "off", label: t("Off") },
          ]}
          value={enabled ? "on" : "off"}
          onChange={(v) => setNapGuide(v === "on")}
        />
        <p className="text-sm text-muted">
          {t(
            "Shows a typical nap window for her age on the Awake card, from a pediatrician-reviewed table (Cleveland Clinic, 2024). A guide, not advice: babies differ from day to day, and tired signs beat any table.",
          )}
        </p>
      </Card>
    </>
  );
}

// The family's own anchor (issue #112): family data about ONE baby, unlike
// the switch above — so it lives on that baby's page.
export function UsualNapCard({ baby }: { baby: Baby }) {
  const summary = useSummary(baby.id);
  const setUsualNap = useSetUsualNap();
  const usual = summary.data?.usualNapMinute ?? null;
  // What the logs say (issue #126): offered, never applied. The anchor is
  // the family's own number, and a number that moves on its own is one a
  // parent stops trusting.
  const sleeps = useRecentSleeps(baby.id);
  const suggestion = usualNapSuggestion(sleeps.data ?? []);
  return (
    <Card className="space-y-2" data-testid="usual-nap">
      <div className="flex items-center gap-2">
        <input
          type="time"
          aria-label={t("Usual nap")}
          value={usual === null ? "" : toClock(usual)}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (Number.isFinite(h) && Number.isFinite(m))
              setUsualNap.mutate({
                babyId: baby.id,
                minute: h! * 60 + m!,
              });
          }}
          className="h-12 min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-4 text-base text-ink tabular-nums"
        />
        {usual !== null && (
          <Button
            variant="ghost"
            onClick={() =>
              setUsualNap.mutate({ babyId: baby.id, minute: null })
            }
          >
            {t("Clear")}
          </Button>
        )}
      </div>
      {suggestion && suggestion.minute !== usual && (
        <div
          className="flex items-center gap-2 rounded-xl2 border border-line bg-surface py-2 pr-2 pl-4"
          data-testid="usual-nap-suggestion"
        >
          <p className="min-w-0 flex-1 text-sm text-ink-soft">
            {suggestion.source === "daycare"
              ? t("Logged at daycare: around")
              : t("Logged at home: around")}{" "}
            <span className="font-bold text-ink tabular-nums">
              {toClock(suggestion.minute)}
            </span>
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setUsualNap.mutate({
                babyId: baby.id,
                minute: suggestion.minute,
              })
            }
          >
            {t("Use this")}
          </Button>
        </div>
      )}
      <p className="text-sm text-muted">
        {t(
          "Your own number. When set, the Awake card says this instead of a window, on weekends too, which is what keeps home days in step with the barnehage. The table stops at 12 months, as its source does.",
        )}
      </p>
    </Card>
  );
}
