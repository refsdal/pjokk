import type {
  FeedLog,
  FeedTimer,
  MedicineCatalogueEntry,
  SleepLog,
  Summary,
} from "@pjokk/shared";
import type { DeviceThreshold } from "./data/devices";
import { clock, totalSeconds } from "./feed-timer-ui";
import { t } from "./i18n";
import type { IdleState } from "./kiosk-screen";
import { nextDoseFrom } from "./medicine-ui";
import { formatClock } from "./time";
import { sleepNoun } from "./sleep-ui";
import { formatVolume, type Units } from "./units";

// Pure view logic for the care station (spec §4–§6): what each card and
// strip says, when a card turns amber, what the undo toast reads, and the
// PIN pad's state machine. No React, no DOM — test/kiosk-ui.test.ts.

// Durations in the compact form ("45 min", "1 h 32 min"): a 48 px headline
// has no room for Home's "1 hour 32 minutes", and the app-wide h:mm form
// reads as a clock time next to an actual clock.
export function durationShort(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} ${t("min")}`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} ${t("min")}`;
}

// Under a minute reads as Home does.
export function elapsedShort(since: Date, now: Date): string {
  const ms = now.getTime() - since.getTime();
  if (ms < 60_000) return t("under a minute");
  return durationShort(ms);
}

export type ReminderLike = {
  kind: string;
  mode: string;
  intervalMin: number | null;
  babyId: string | null;
};

// Amber when a since_last reminder for this kind has elapsed — the family's
// threshold, exactly as the push nudge uses it. On a kiosk device these are
// every caretaker's (GET /api/device/thresholds, via thresholdsToReminders):
// whoever set the tightest interval is the one the card answers to. No
// reminder, no amber.
export function cautionFor(
  kind: "feed" | "diaper",
  lastAt: Date | null,
  reminders: ReminderLike[],
  babyId: string,
  now = new Date(),
): boolean {
  if (!lastAt) return false;
  const elapsedMin = (now.getTime() - lastAt.getTime()) / 60_000;
  return reminders.some(
    (r) =>
      r.kind === kind &&
      r.mode === "since_last" &&
      r.intervalMin != null &&
      (r.babyId == null || r.babyId === babyId) &&
      elapsedMin > r.intervalMin,
  );
}

// The family's thresholds (spec 2026-09-10-kiosk-devices §5) in the shape
// cautionFor reads: a device gets intervals only, all of them since_last.
export function thresholdsToReminders(
  thresholds: DeviceThreshold[],
): ReminderLike[] {
  return thresholds.map((th) => ({
    kind: th.kind,
    mode: "since_last",
    intervalMin: th.intervalMin,
    babyId: th.babyId ?? null,
  }));
}

// Who is logging lasts until the kiosk dims (spec 2026-09-10 §6): two
// minutes without a touch means nobody is standing there, and the next
// person should say who they are rather than inherit a name.
export function caretakerAfterIdle(
  state: IdleState,
  current: string | null,
): string | null {
  return state === "dim" ? null : current;
}

// What the kiosk's DeviceGate makes of GET /api/device (spec 2026-09-10-
// kiosk-devices §6). NOT_A_DEVICE is ambiguous: a tablet made a kiosk the
// old way has never had a device, but a revoked one answers the same once a
// sibling request's 401 has already cleared its cookie — and that one HAS
// had a device (its answer is cached). Only the first is an old-style kiosk.
// While leaving is under way the gate says nothing at all.
export type DeviceGateVerdict = "ok" | "revoked" | "not-a-device" | "leaving";

export function deviceGateVerdict(s: {
  code: string | null;
  hadDevice: boolean;
  revoked: boolean;
  leaving: boolean;
}): DeviceGateVerdict {
  if (s.leaving) return "leaving";
  if (s.revoked || s.code === "DEVICE_REVOKED") return "revoked";
  if (s.code === "NOT_A_DEVICE")
    return s.hadDevice ? "revoked" : "not-a-device";
  return "ok";
}

export function totalsLines(
  today: Summary["today"],
  units: Units,
): [string, string] {
  const diapers = today.wet + today.dirty + today.both + today.dry;
  return [
    `${today.feeds} ${t("feeds")} · ${formatVolume(today.intakeMl, units)}`,
    `${diapers} ${t("diapers")} · ${durationShort(today.sleepMin * 60_000)} ${t("sleep")}`,
  ];
}

export function sleepCardView(
  s: { activeSleep: SleepLog | null; lastSleep: SleepLog | null },
  now: Date,
): {
  state: "awake" | "sleeping" | "none";
  headline: string;
  detail: string;
} {
  if (s.activeSleep) {
    const start = new Date(s.activeSleep.startTime);
    return {
      state: "sleeping",
      headline: elapsedShort(start, now),
      detail: [`${t("since")} ${formatClock(start)}`, s.activeSleep.location]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (s.lastSleep?.endTime) {
    const start = new Date(s.lastSleep.startTime);
    const end = new Date(s.lastSleep.endTime);
    return {
      state: "awake",
      headline: elapsedShort(end, now),
      detail: [
        `${t("after a")} ${durationShort(end.getTime() - start.getTime())} ${sleepNoun(s.lastSleep.type)}`,
        s.lastSleep.location,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return { state: "none", headline: "—", detail: t("No sleep logged yet") };
}

export function feedCardView(
  s: { lastFeed: FeedLog | null; activeFeed: FeedTimer | null },
  units: Units,
  now: Date,
): { live: boolean; headline: string; detail: string } {
  if (s.activeFeed) {
    const side =
      s.activeFeed.runningSide === "left"
        ? t("left side")
        : s.activeFeed.runningSide === "right"
          ? t("right side")
          : t("paused");
    return {
      live: true,
      headline: clock(totalSeconds(s.activeFeed, now.getTime())),
      detail: `${side} · ${t("since")} ${formatClock(new Date(s.activeFeed.startTime))}`,
    };
  }
  const f = s.lastFeed;
  if (!f)
    return { live: false, headline: "—", detail: t("No feed logged yet") };
  const what =
    f.type === "bottle"
      ? [
          f.amountMl != null ? formatVolume(f.amountMl, units) : null,
          f.contents ? t(f.contents) : null,
        ]
          .filter(Boolean)
          .join(" ")
      : f.type === "breast"
        ? [t("breast"), f.side, f.durationMin ? `${f.durationMin} min` : null]
            .filter(Boolean)
            .join(" ")
        : t("solids");
  return {
    live: false,
    headline: elapsedShort(new Date(f.time), now),
    detail: `${t("ago")} · ${what}`,
  };
}

// The quick Bottle action logs the last bottle again (last-value prefill).
export function lastBottle(feeds: FeedLog[]): {
  amountMl: number;
  contents: FeedLog["contents"];
} {
  const last = feeds.find((f) => f.type === "bottle");
  return { amountMl: last?.amountMl ?? 120, contents: last?.contents ?? null };
}

const DAY_MS = 24 * 60 * 60_000;

export function medicineStripView(
  e: MedicineCatalogueEntry,
  now: Date,
): { show: boolean; okText: string; ahead: boolean } {
  if (e.archived || !e.lastDoseAt)
    return { show: false, okText: "", ahead: false };
  const last = new Date(e.lastDoseAt);
  const next = nextDoseFrom(e, now);
  const ahead = !!next && next.getTime() > now.getTime();
  const recent = now.getTime() - last.getTime() < DAY_MS;
  if (!ahead && !recent) return { show: false, okText: "", ahead: false };
  return {
    show: true,
    ahead,
    okText:
      ahead && next ? `${t("OK from")} ${formatClock(next)}` : t("OK now"),
  };
}

export type UndoKind = "feed" | "diaper" | "sleep" | "medicine";

export function undoText(kind: UndoKind, detail?: string): string {
  switch (kind) {
    case "diaper":
      return `${t(capitalize(detail ?? "diaper"))} ${t("diaper logged")}`;
    case "feed":
      return `${t("Bottle")} ${detail ?? ""} ${t("logged")}`.replace(
        /\s+/g,
        " ",
      );
    case "sleep":
      return t("Sleep started");
    case "medicine":
      return `${detail ?? t("Medicine")} ${t("logged")}`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- PIN pad --------------------------------------------------------------
export const PIN_LOCKOUT_MS = 30_000;
export const PIN_MAX_WRONG = 3;

export type PinPadState = {
  digits: string;
  wrong: number;
  error: string | null;
};
export type PinPadEvent =
  | { type: "digit"; d: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "wrong" }
  // A server answer that is not "wrong PIN" (too many tries, no
  // connection): shown, but not counted towards the pad's own lockout.
  | { type: "message"; text: string };

export function pinPadReducer(
  s: PinPadState,
  e: PinPadEvent,
  max: number,
): PinPadState {
  switch (e.type) {
    case "digit":
      if (s.digits.length >= max) return s;
      return { ...s, digits: s.digits + e.d, error: null };
    case "backspace":
      return { ...s, digits: s.digits.slice(0, -1), error: null };
    case "clear":
      return { ...s, digits: "", error: null };
    case "wrong":
      return { digits: "", wrong: s.wrong + 1, error: t("Wrong PIN") };
    case "message":
      return { ...s, digits: "", error: e.text };
  }
}
