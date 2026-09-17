import { useEffect, useState } from "react";
import type { IllnessLog } from "@pjokk/shared";
import { Button } from "@/components/ui/button";
import { useRecoverIllness, useUpdateIllness } from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  clockLines,
  illnessClock,
  illnessMeta,
  symptomsLine,
} from "@/lib/illness-ui";
import { describeTime } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

// An open illness on Home (issue #107): state, like the barnehage banner,
// and as calm — it sits here for days. Two lines answer the two questions
// of a sick week with zero taps: what she has and since when, and how long
// she has been symptom-free against the family's own number of hours
// (lib/illness-ui.ts). It never says what to do about it.
type Reading = { type: string; value: number; time: string };

export function IllnessCard({
  illness,
  readings,
  onEdit,
}: {
  illness: IllnessLog;
  // Recent temperatures: a fever logged after "symptom-free" moves the clock.
  readings: Reading[];
  onEdit: (illness: IllnessLog) => void;
}) {
  const update = useUpdateIllness();
  const recover = useRecoverIllness();
  // Re-render each minute: the clock's state changes with the time alone.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const optimistic = illness.id === "optimistic";
  const clock = illnessClock(illness, readings);
  const Icon = illnessMeta.icon;
  const setLast = (lastSymptomAt: string | null) =>
    update.mutate({
      id: illness.id,
      babyId: illness.babyId,
      patch: { lastSymptomAt },
    });

  return (
    <div className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
      <button
        type="button"
        disabled={optimistic}
        onClick={() => onEdit(illness)}
        aria-label={t("Edit illness")}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl text-left active:bg-surface-2",
          focusRing,
        )}
      >
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2",
            illnessMeta.tint,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold tracking-wide text-muted uppercase">
            {t("Ill since")} {describeTime(new Date(illness.startTime))}
          </span>
          <span className="block truncate text-base font-bold text-ink">
            {illness.symptoms.length > 0
              ? symptomsLine(illness.symptoms)
              : t("Illness")}
          </span>
          <span data-testid="illness-clock">
            {clockLines(clock).map((line) => (
              <span
                key={line}
                className="block text-xs font-medium text-ink-soft"
              >
                {line}
              </span>
            ))}
          </span>
        </span>
      </button>
      <div className="flex gap-2">
        {clock.state === "symptoms" ? (
          <Button
            variant="secondary"
            className="flex-1"
            disabled={optimistic}
            onClick={() => setLast(new Date().toISOString())}
          >
            {t("Symptom-free now")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            className="flex-1"
            disabled={optimistic}
            onClick={() => setLast(null)}
          >
            {t("Symptoms again")}
          </Button>
        )}
        <Button
          variant="outline"
          className="flex-1"
          disabled={optimistic || recover.isPending}
          onClick={() => recover.mutate({ id: illness.id })}
        >
          {t("Recovered")}
        </Button>
      </div>
    </div>
  );
}
