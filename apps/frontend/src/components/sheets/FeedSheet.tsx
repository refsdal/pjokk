import { useEffect, useMemo, useState } from "react";
import type { FeedLog, FeedTimer } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isOptimisticTimer,
  useDeleteFeed,
  useDiscardFeedTimer,
  useLogFeed,
  useSetFeedTimerSide,
  useStartFeedTimer,
  useStopFeedTimer,
  useUpdateFeed,
} from "@/lib/data";
import { clock, minutesFromSeconds, sideSeconds } from "@/lib/feed-timer-ui";
import { t } from "@/lib/i18n";
import { useUnits, volumeScale } from "@/lib/units";
import { type FeedContents, feedContentsOptions } from "@/lib/log-detail";
import { toast } from "@/lib/toast";

type FeedType = "bottle" | "breast" | "solids";
type Side = "left" | "right" | "both";

// Legacy rows (pre per-side minutes) only have side + total durationMin —
// reconstruct a left/right split so the steppers still seed sensibly.
function deriveLegacySides(
  side: Side | null | undefined,
  durationMin: number | null | undefined,
): { left: number; right: number } {
  const total = durationMin ?? 0;
  if (side === "right") return { left: 0, right: total };
  if (side === "both") {
    const left = Math.ceil(total / 2);
    return { left, right: total - left };
  }
  return { left: total, right: 0 };
}

function sidesFromFeed(
  feed: FeedLog | null | undefined,
): { left: number; right: number } | null {
  if (!feed) return null;
  if (feed.leftMin != null || feed.rightMin != null) {
    return { left: feed.leftMin ?? 0, right: feed.rightMin ?? 0 };
  }
  return deriveLegacySides(feed.side, feed.durationMin);
}

// ONE component for create and edit (CLAUDE.md). Create: happy path is two
// taps, prefilled from the last feed of the same type. Edit: prefilled from
// the entry, plus delete.
//
// The nursing timer is the family's shared feed_timer row (issue #44),
// handed in as `activeFeed` from the summary: it used to be this device's
// localStorage, which no co-parent could see. The sheet only ever sends
// "start left", "switch", "pause", "stop" — the seconds are the server's.
export function FeedSheet({
  open,
  onOpenChange,
  babyId,
  recentFeeds,
  activeFeed = null,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  recentFeeds: FeedLog[];
  activeFeed?: FeedTimer | null;
  edit?: FeedLog | null;
}) {
  const lastByType = useMemo(() => {
    const map = new Map<FeedType, FeedLog>();
    for (const f of recentFeeds) {
      if (!map.has(f.type)) map.set(f.type, f);
    }
    return map;
  }, [recentFeeds]);

  // Distinct foods from the recent solids feeds, newest first, as keyboard
  // suggestions — the second banana of the day is one tap, not a word.
  const recentFoods = useMemo(() => {
    const seen = new Set<string>();
    for (const f of recentFeeds) {
      if (f.type === "solids" && f.food) seen.add(f.food);
    }
    return [...seen].slice(0, 12);
  }, [recentFeeds]);

  const [type, setType] = useState<FeedType>("bottle");
  const [amountMl, setAmountMl] = useState(120);
  const units = useUnits();
  const volume = volumeScale(units);
  // Optional detail (issue #43): what a bottle held; what the solids were
  // and whether they caused a reaction. Contents and food prefill from the
  // last feed of the same type (the same formula, the same puree twice a
  // day); a reaction is an observation of THIS meal and never prefills.
  const [contents, setContents] = useState<FeedContents | null>(null);
  const [food, setFood] = useState("");
  const [reaction, setReaction] = useState(false);
  const [leftMin, setLeftMin] = useState(10);
  const [rightMin, setRightMin] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  // Bumped on every open so TimeField remounts with fresh initial state.
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  // The timer only matters on the create path: editing a past entry must
  // never touch a clock that is running for the CURRENT feed.
  const timer = edit ? null : activeFeed;
  const timerBusy = isOptimisticTimer(timer);

  // Ticks the live clocks once a second while a side is running and the
  // sheet is open. The timer's own state lives on the server.
  useEffect(() => {
    if (!open || !timer?.runningSide) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, timer?.runningSide]);

  const applyPrefill = (feedType: FeedType) => {
    const last = lastByType.get(feedType);
    if (feedType === "bottle") {
      setAmountMl(last?.amountMl ?? 120);
      setContents(last?.contents ?? null);
    }
    if (feedType === "solids") {
      setAmountMl(last?.amountMl ?? 40);
      setFood(last?.food ?? "");
      setReaction(false);
    }
    if (feedType === "breast") {
      const sides = sidesFromFeed(last) ?? { left: 10, right: 0 };
      // With a timer running the steppers follow the clock (see liveLeft /
      // liveRight); seed them at zero so the clock is what the parent sees.
      setLeftMin(timer ? 0 : sides.left);
      setRightMin(timer ? 0 : sides.right);
    }
  };

  // Initialize synchronously on open (state-during-render derived pattern),
  // so children mount with the right values.
  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    setNow(Date.now());
    if (edit) {
      setType(edit.type);
      setAmountMl(edit.amountMl ?? (edit.type === "solids" ? 40 : 120));
      setContents(edit.contents ?? null);
      setFood(edit.food ?? "");
      setReaction(edit.reaction === true);
      const sides = sidesFromFeed(edit) ?? { left: 10, right: 0 };
      setLeftMin(sides.left);
      setRightMin(sides.right);
      setTime(new Date(edit.time));
    } else {
      // A running timer is the feed the parent is here to finish.
      const initial: FeedType = timer
        ? "breast"
        : (recentFeeds[0]?.type ?? "bottle");
      setType(initial);
      setTime(null);
      applyPrefill(initial);
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const startTimer = useStartFeedTimer();
  const setSide = useSetFeedTimerSide();
  const stopTimer = useStopFeedTimer();
  const discardTimer = useDiscardFeedTimer();

  // Tapping a side's button: start the family timer on that side, switch
  // to it, or pause it if it is the one running.
  const toggleTimer = (side: "left" | "right") => {
    if (!timer) {
      // From here on the clock drives the steppers; a prefilled "10 min"
      // next to a clock at 00:00 would be a lie.
      setLeftMin(0);
      setRightMin(0);
      startTimer.mutate({
        babyId,
        kind: "breast",
        side,
        startTime: new Date().toISOString(),
      });
      return;
    }
    if (timerBusy) return;
    setSide.mutate({
      id: timer.id,
      babyId,
      side: timer.runningSide === side ? null : side,
    });
  };

  const resetTimer = () => {
    if (!timer || timerBusy) return;
    discardTimer.mutate({ id: timer.id, babyId, kind: "breast" });
  };

  const changeType = (v: FeedType) => {
    setType(v);
    if (!edit) applyPrefill(v);
  };

  const logFeed = useLogFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();

  // What the steppers show: never below what the clock has banked, never
  // below what the parent dialed in by hand.
  const liveLeft = timer
    ? Math.max(leftMin, minutesFromSeconds(sideSeconds(timer, "left", now)))
    : leftMin;
  const liveRight = timer
    ? Math.max(rightMin, minutesFromSeconds(sideSeconds(timer, "right", now)))
    : rightMin;
  const breastSide: Side =
    liveLeft > 0 && liveRight > 0 ? "both" : liveRight > 0 ? "right" : "left";
  const canSave = type !== "breast" || (liveLeft + liveRight > 0 && !timerBusy);

  const save = () => {
    if (!canSave) return;
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    const trimmedFood = food.trim().slice(0, 100);
    if (edit) {
      updateFeed.mutate({
        id: edit.id,
        patch: {
          time: when,
          type,
          amountMl: type === "breast" ? null : amountMl,
          side: type === "breast" ? breastSide : null,
          durationMin: type === "breast" ? liveLeft + liveRight : null,
          leftMin: type === "breast" ? liveLeft : null,
          rightMin: type === "breast" ? liveRight : null,
          // Detail follows the type: a switch clears what no longer applies.
          contents: type === "bottle" ? contents : null,
          food: type === "solids" ? trimmedFood || null : null,
          reaction: type === "solids" && reaction ? true : null,
          notes: trimmedNotes || null,
        },
      });
    } else if (type === "breast" && timer) {
      // Saving a timed feed IS stopping the timer: the server logs the row
      // from its own clock, with the steppers as the parent's override.
      stopTimer.mutate({
        id: timer.id,
        babyId,
        kind: "breast",
        leftMin: liveLeft,
        rightMin: liveRight,
        // Only a time the parent picked; otherwise the feed keeps the
        // moment the timer started.
        ...(time ? { time: when } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } else {
      logFeed.mutate({
        babyId,
        time: when,
        type,
        ...(type === "breast"
          ? {
              side: breastSide,
              durationMin: liveLeft + liveRight,
              leftMin: liveLeft,
              rightMin: liveRight,
            }
          : { amountMl }),
        ...(type === "bottle" && contents ? { contents } : {}),
        ...(type === "solids" && trimmedFood ? { food: trimmedFood } : {}),
        ...(type === "solids" && reaction ? { reaction: true } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteFeed.mutate({ id: edit.id });
    onOpenChange(false);
  };

  const sideRow = (side: "left" | "right") => {
    const running = timer?.runningSide === side;
    const seconds = timer ? sideSeconds(timer, side, now) : 0;
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between px-1">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            {side === "left" ? t("Left") : t("Right")}
          </p>
          {!edit && (
            <button
              type="button"
              onClick={() => toggleTimer(side)}
              disabled={timerBusy}
              className="rounded-full bg-surface-2 px-3 py-1 text-sm font-semibold text-ink active:scale-95 disabled:opacity-60"
            >
              {running
                ? `${t("Pause")} · ${clock(seconds)}`
                : seconds > 0
                  ? `${t("Resume")} · ${clock(seconds)}`
                  : t("Start timer")}
            </button>
          )}
        </div>
        <Stepper
          value={side === "left" ? liveLeft : liveRight}
          onChange={side === "left" ? setLeftMin : setRightMin}
          step={1}
          min={0}
          max={90}
          unit="min"
        />
      </div>
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t("Edit feed") : t("Feed")}
    >
      <div className="space-y-5 pb-4">
        <ChipGroup
          options={[
            { value: "bottle", label: t("Bottle") },
            { value: "breast", label: t("Breast") },
            { value: "solids", label: t("Solids") },
          ]}
          value={type}
          onChange={changeType}
        />

        {type === "bottle" && (
          // State stays in ml; the stepper shows the person's units and only
          // a stepped value is converted back (lib/units.ts).
          <Stepper
            value={volume.toDisplay(amountMl)}
            onChange={(v) => setAmountMl(volume.toCanonical(v))}
            step={
              units === "metric"
                ? (v, dir) => ((dir > 0 ? v < 50 : v <= 50) ? 5 : 10)
                : volume.step
            }
            min={volume.min}
            max={volume.max}
            decimals={volume.decimals}
            unit={volume.unit}
          />
        )}
        {type === "solids" && (
          <Stepper
            value={amountMl}
            onChange={setAmountMl}
            step={5}
            min={5}
            max={500}
            unit="g"
          />
        )}

        {type === "bottle" && (
          <ChipGroup
            options={feedContentsOptions.map((o) => ({
              value: o.value,
              label: t(o.label),
            }))}
            value={contents}
            // Optional field: tapping the selected chip clears it.
            onChange={(v) => setContents(v === contents ? null : v)}
          />
        )}

        {type === "solids" && (
          <div className="space-y-3">
            <Input
              list="pjokk-recent-foods"
              placeholder={t("Food (optional)")}
              value={food}
              maxLength={100}
              onChange={(e) => setFood(e.target.value)}
            />
            <datalist id="pjokk-recent-foods">
              {recentFoods.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <ChipGroup
              options={[{ value: "reaction", label: t("Reaction") }]}
              value={reaction ? "reaction" : null}
              onChange={() => setReaction((r) => !r)}
            />
          </div>
        )}

        {type === "breast" && (
          <>
            {timer && timer.caretakerName && (
              <p className="px-1 text-sm text-muted">
                {t("Timer started by")} {timer.caretakerName}
              </p>
            )}
            {sideRow("left")}
            {sideRow("right")}
            {timer && (
              <button
                type="button"
                onClick={resetTimer}
                disabled={timerBusy}
                className="px-1 text-xs text-muted underline disabled:opacity-60"
              >
                {t("Discard timer")}
              </button>
            )}
          </>
        )}

        <TimeField key={instance} value={time} onChange={setTime} />

        <Input
          placeholder={t("Note (optional)")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <Button size="full" onClick={save} disabled={!canSave}>
          {t("Save")}
        </Button>

        {edit && <DeleteButton onDelete={remove} />}
      </div>
    </Sheet>
  );
}
