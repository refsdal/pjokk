import { IconPlus, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { DaycareLog } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { Sheet, useSheetReset } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { useDaycares, useHandover, useSaveHandover } from "@/lib/data";
import {
  type HandoverDraft,
  MAX_NAPS,
  type MealSlot,
  dismissHandover,
  draftFor,
  mealSlots,
  moodOptions,
  napIsBackwards,
  napOutsideDay,
  napToAdd,
  toHandover,
} from "@/lib/handover-ui";
import { t } from "@/lib/i18n";
import { feedAppetiteOptions } from "@/lib/log-detail";
import { formatClock } from "@/lib/time";
import { toast } from "@/lib/toast";
import { cn, focusRing } from "@/lib/utils";

// What the staff said at pick-up (issue #106), in the order they say it:
// the nap, the meals, the nappies, how the day went. ONE sheet that saves
// ordinary sleep, feed and diaper rows (lib/handover-ui.ts), so Timeline
// and Stats stay whole without three sheets and three back-dated times.
//
// Everything is optional. The common handover — "she slept fine" — is the
// prefilled nap and Save: two taps from the card on Home.

const clockInput =
  "h-12 min-w-0 flex-1 rounded-xl2 border border-line bg-surface px-3 text-base text-ink tabular-nums";

function Heading({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </p>
  );
}

export function HandoverSheet({
  open,
  onOpenChange,
  day,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The finished day the handover belongs to; null while closed.
  day: DaycareLog | null;
}) {
  const saved = useHandover(day?.id, open);
  // Yesterday's clock times are today's best guess: the two newest days,
  // of which the one that is not this day is the previous.
  const recent = useDaycares(day?.babyId, 2, open);
  const previousId = recent.data?.find((d) => d.id !== day?.id)?.id;
  const previous = useHandover(previousId, open);
  const save = useSaveHandover();

  const [draft, setDraft] = useState<HandoverDraft | null>(null);
  useSheetReset(open, () => setDraft(null));
  // The draft is seeded once, when what it opens on has SETTLED — a cached
  // answer still being refetched is the handover as it was before the last
  // save — and never again, or a background refetch would wipe what was
  // just tapped. Offline (a paused fetch) or failed, it opens on what it
  // has: a handover typed in a cloakroom with no signal must still save.
  const settled = (q: {
    isFetching: boolean;
    isPending: boolean;
    fetchStatus: string;
    isError: boolean;
  }) =>
    q.isError || q.fetchStatus === "paused" || (!q.isPending && !q.isFetching);
  const ready =
    settled(saved) && settled(recent) && (!previousId || settled(previous));
  if (open && day && ready && draft === null) {
    setDraft(draftFor(saved.data ?? null, previous.data ?? null, day));
  }

  if (!day) return null;
  const edit = (patch: Partial<HandoverDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));
  const setNap = (i: number, patch: Partial<HandoverDraft["naps"][number]>) =>
    draft &&
    edit({
      naps: draft.naps.map((n, j) => (j === i ? { ...n, ...patch } : n)),
    });
  const setMeal = (
    slot: MealSlot,
    appetite: HandoverDraft["meals"][MealSlot]["appetite"],
  ) =>
    draft &&
    edit({
      meals: { ...draft.meals, [slot]: { ...draft.meals[slot], appetite } },
    });

  const backwards = !!draft && draft.naps.some(napIsBackwards);
  // The handover is about the hours she was there (lib/handover-ui.ts).
  const outside =
    !!draft && !backwards && draft.naps.some((n) => napOutsideDay(n, day));

  const submit = () => {
    if (!draft) return;
    save.mutate({ id: day.id, handover: toHandover(draft, day) });
    // Saved or not, the question has been answered on this device.
    dismissHandover(day.id);
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t("Handover")}>
      {!draft ? (
        <p className="py-8 text-center text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <div className="space-y-5 pb-4">
          <div className="space-y-2">
            <Heading>{t("Nap")}</Heading>
            {draft.naps.length === 0 && (
              <p className="text-sm text-muted">{t("No nap today.")}</p>
            )}
            {draft.naps.map((nap, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their position
              <div key={i} className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label={t("Nap started")}
                  value={nap.start}
                  onChange={(e) => setNap(i, { start: e.target.value })}
                  className={clockInput}
                />
                <span className="text-muted">–</span>
                <input
                  type="time"
                  aria-label={t("Nap ended")}
                  value={nap.end}
                  onChange={(e) => setNap(i, { end: e.target.value })}
                  className={clockInput}
                />
                <button
                  type="button"
                  aria-label={t("Remove nap")}
                  onClick={() =>
                    edit({ naps: draft.naps.filter((_, j) => j !== i) })
                  }
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-2",
                    focusRing,
                  )}
                >
                  <IconX className="h-5 w-5" />
                </button>
              </div>
            ))}
            {draft.naps.length < MAX_NAPS && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => edit({ naps: [...draft.naps, napToAdd(day)] })}
              >
                <IconPlus className="mr-1 h-4 w-4" />
                {t("Add a nap")}
              </Button>
            )}
            {backwards && (
              <p className="text-sm text-diaper">
                {t("The end time is before the start time.")}
              </p>
            )}
            {outside && (
              <p className="text-sm text-diaper">
                {t("A nap there must be between drop-off and pick-up")} (
                {formatClock(new Date(day.startTime))}–
                {day.endTime ? formatClock(new Date(day.endTime)) : t("now")})
              </p>
            )}
          </div>

          <div className="space-y-3">
            <Heading>{t("Meals")}</Heading>
            {mealSlots
              .filter((slot) => draft.meals[slot.key].offered)
              .map((slot) => (
                <div key={slot.key} className="space-y-1.5">
                  <p className="text-sm font-semibold text-ink">
                    {t(slot.label)}
                    <span className="ml-1.5 font-normal text-muted tabular-nums">
                      {draft.meals[slot.key].clock}
                    </span>
                  </p>
                  <fieldset aria-label={t(slot.label)}>
                    <ChipGroup
                      options={feedAppetiteOptions.map((o) => ({
                        value: o.value,
                        label: t(o.label),
                      }))}
                      value={draft.meals[slot.key].appetite}
                      // Tapping the selected chip takes the meal out again.
                      onChange={(v) =>
                        setMeal(
                          slot.key,
                          v === draft.meals[slot.key].appetite ? null : v,
                        )
                      }
                    />
                  </fieldset>
                </div>
              ))}
          </div>

          <div className="space-y-2">
            <Heading>{t("Diapers")}</Heading>
            {/* A count, not times: the server spreads them over the day. */}
            <div className="grid grid-cols-2 gap-3">
              <Stepper
                value={draft.wet}
                onChange={(wet) => edit({ wet })}
                step={1}
                min={0}
                max={10}
                unit={t("wet")}
              />
              <Stepper
                value={draft.dirty}
                onChange={(dirty) => edit({ dirty })}
                step={1}
                min={0}
                max={10}
                unit={t("dirty")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Heading>{t("The day")}</Heading>
            <ChipGroup
              options={moodOptions.map((o) => ({
                value: o.value,
                label: t(o.label),
              }))}
              value={draft.mood}
              onChange={(v) => edit({ mood: v === draft.mood ? null : v })}
            />
          </div>

          <Button size="full" onClick={submit} disabled={backwards || outside}>
            {t("Save")}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
