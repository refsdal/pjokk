import { useEffect, useMemo, useState } from "react";
import type { FeedLog } from "@pjokk/shared";
import { ChipGroup } from "@/components/Chips";
import { DeleteButton } from "@/components/DeleteButton";
import { Sheet } from "@/components/Sheet";
import { Stepper } from "@/components/Stepper";
import { TimeField } from "@/components/TimeField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeleteFeed, useLogFeed, useUpdateFeed } from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  clearNursing,
  loadNursing,
  saveNursing,
  sideSeconds,
  type NursingTimer,
} from "@/lib/nursing-timer";
import { toast } from "@/lib/toast";

type FeedType = "bottle" | "breast" | "solids";
type Side = "left" | "right" | "both";

const emptyTimer: NursingTimer = {
  running: null,
  startedAt: null,
  leftSec: 0,
  rightSec: 0,
};

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Whole minutes for a side's accrued seconds — 0 when nothing accrued,
 *  otherwise at least 1 (so a 20-second toggle still registers). */
function minutesFromSeconds(sec: number): number {
  return sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0;
}

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
export function FeedSheet({
  open,
  onOpenChange,
  babyId,
  recentFeeds,
  edit = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  babyId: string;
  recentFeeds: FeedLog[];
  edit?: FeedLog | null;
}) {
  const lastByType = useMemo(() => {
    const map = new Map<FeedType, FeedLog>();
    for (const f of recentFeeds) {
      if (!map.has(f.type)) map.set(f.type, f);
    }
    return map;
  }, [recentFeeds]);

  const [type, setType] = useState<FeedType>("bottle");
  const [amountMl, setAmountMl] = useState(120);
  const [leftMin, setLeftMin] = useState(10);
  const [rightMin, setRightMin] = useState(0);
  const [timer, setTimer] = useState<NursingTimer>(emptyTimer);
  const [now, setNow] = useState(() => Date.now());
  const [time, setTime] = useState<Date | null>(null);
  const [notes, setNotes] = useState("");
  // Bumped on every open so TimeField remounts with fresh initial state.
  const [instance, setInstance] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);

  // Ticks the clock/derived seconds once a second while a side is running
  // and the sheet is open. The timer's own state (running/startedAt) lives
  // in localStorage via nursing-timer.ts, so it keeps counting across the
  // sheet closing/reopening — this effect only drives the live display.
  useEffect(() => {
    if (!open || !timer.running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, timer.running]);

  const applyPrefill = (
    feedType: FeedType,
    currentTimer: NursingTimer = timer,
  ) => {
    const last = lastByType.get(feedType);
    if (feedType === "bottle") setAmountMl(last?.amountMl ?? 120);
    if (feedType === "solids") setAmountMl(last?.amountMl ?? 40);
    if (feedType === "breast") {
      const hasAccrual =
        currentTimer.leftSec > 0 ||
        currentTimer.rightSec > 0 ||
        currentTimer.running !== null;
      if (hasAccrual) {
        setLeftMin(minutesFromSeconds(sideSeconds(currentTimer, "left")));
        setRightMin(minutesFromSeconds(sideSeconds(currentTimer, "right")));
      } else {
        const sides = sidesFromFeed(last) ?? { left: 10, right: 0 };
        setLeftMin(sides.left);
        setRightMin(sides.right);
      }
    }
  };

  // Initialize synchronously on open (state-during-render derived pattern),
  // so children mount with the right values.
  if (open && !wasOpen) {
    setWasOpen(true);
    setInstance((i) => i + 1);
    setNotes(edit?.notes ?? "");
    const loadedTimer = loadNursing();
    setTimer(loadedTimer);
    setNow(Date.now());
    if (edit) {
      setType(edit.type);
      setAmountMl(edit.amountMl ?? (edit.type === "solids" ? 40 : 120));
      const sides = sidesFromFeed(edit) ?? { left: 10, right: 0 };
      setLeftMin(sides.left);
      setRightMin(sides.right);
      setTime(new Date(edit.time));
    } else {
      const initial = recentFeeds[0]?.type ?? "bottle";
      setType(initial);
      setTime(null);
      applyPrefill(initial, loadedTimer);
    }
  }
  if (!open && wasOpen) {
    setWasOpen(false);
  }

  const toggleTimer = (side: "left" | "right") => {
    const clickedAt = Date.now();
    let next = timer;
    if (next.running) {
      const key = next.running === "left" ? "leftSec" : "rightSec";
      next = {
        ...next,
        [key]: sideSeconds(next, next.running, clickedAt),
        running: null,
        startedAt: null,
      };
    }
    if (timer.running !== side) {
      next = { ...next, running: side, startedAt: clickedAt };
    }
    setTimer(next);
    saveNursing(next);
    setNow(clickedAt);
    // Bank whichever whole minutes just accrued, without ever moving the
    // stepper backwards past a value the user already dialed in by hand.
    setLeftMin((v) =>
      Math.max(v, minutesFromSeconds(sideSeconds(next, "left", clickedAt))),
    );
    setRightMin((v) =>
      Math.max(v, minutesFromSeconds(sideSeconds(next, "right", clickedAt))),
    );
  };

  const resetTimer = () => {
    clearNursing();
    setTimer(emptyTimer);
  };

  const changeType = (v: FeedType) => {
    setType(v);
    if (!edit) applyPrefill(v);
  };

  const logFeed = useLogFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeed = useDeleteFeed();

  const breastSide: Side =
    leftMin > 0 && rightMin > 0 ? "both" : rightMin > 0 ? "right" : "left";
  const canSave = type !== "breast" || leftMin + rightMin > 0;

  const save = () => {
    if (!canSave) return;
    const when = (time ?? new Date()).toISOString();
    const trimmedNotes = notes.trim();
    if (edit) {
      updateFeed.mutate({
        id: edit.id,
        patch: {
          time: when,
          type,
          amountMl: type === "breast" ? null : amountMl,
          side: type === "breast" ? breastSide : null,
          durationMin: type === "breast" ? leftMin + rightMin : null,
          leftMin: type === "breast" ? leftMin : null,
          rightMin: type === "breast" ? rightMin : null,
          notes: trimmedNotes || null,
        },
      });
    } else {
      logFeed.mutate({
        babyId,
        time: when,
        type,
        ...(type === "breast"
          ? {
              side: breastSide,
              durationMin: leftMin + rightMin,
              leftMin,
              rightMin,
            }
          : { amountMl }),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    }
    // Only the create path's steppers are seeded from the live nursing
    // timer — editing a past entry must never clear a timer that's still
    // running for the CURRENT feed.
    if (type === "breast" && !edit) {
      clearNursing();
      setTimer(emptyTimer);
    }
    if (!navigator.onLine) toast(t("Saved offline — will sync"));
    onOpenChange(false);
  };

  const remove = () => {
    if (!edit) return;
    deleteFeed.mutate({ id: edit.id });
    onOpenChange(false);
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

        {(type === "bottle" || type === "solids") && (
          <Stepper
            value={amountMl}
            onChange={setAmountMl}
            step={
              type === "bottle"
                ? (v, dir) => ((dir > 0 ? v < 50 : v <= 50) ? 5 : 10)
                : 5
            }
            min={5}
            max={500}
            unit={type === "solids" ? "g" : "ml"}
          />
        )}

        {type === "breast" && (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("Left")}
                </p>
                <button
                  type="button"
                  onClick={() => toggleTimer("left")}
                  className="rounded-full bg-surface-2 px-3 py-1 text-sm font-semibold text-ink active:scale-95"
                >
                  {timer.running === "left"
                    ? `${t("Stop")} · ${clock(sideSeconds(timer, "left", now))}`
                    : t("Start timer")}
                </button>
              </div>
              <Stepper
                value={leftMin}
                onChange={setLeftMin}
                step={1}
                min={0}
                max={90}
                unit="min"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {t("Right")}
                </p>
                <button
                  type="button"
                  onClick={() => toggleTimer("right")}
                  className="rounded-full bg-surface-2 px-3 py-1 text-sm font-semibold text-ink active:scale-95"
                >
                  {timer.running === "right"
                    ? `${t("Stop")} · ${clock(sideSeconds(timer, "right", now))}`
                    : t("Start timer")}
                </button>
              </div>
              <Stepper
                value={rightMin}
                onChange={setRightMin}
                step={1}
                min={0}
                max={90}
                unit="min"
              />
            </div>

            {(timer.leftSec + timer.rightSec > 0 || timer.running) && (
              <button
                type="button"
                onClick={resetTimer}
                className="px-1 text-xs text-muted underline"
              >
                {t("Reset timer")}
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
