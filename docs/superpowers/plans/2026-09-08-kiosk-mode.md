# Kiosk Mode ("care station") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-device kiosk switch that turns a tablet into the family's care station: its own slate palette, a clock band, three cards that log with one tap and an Undo, a medicine strip, wake lock, idle dim, and a local PIN to leave — with no server change.

**Architecture:** Device state in localStorage behind a tiny external store (`lib/kiosk.ts`), mirrored to a `kiosk` class on `<html>` by the boot script and the AppearanceProvider. A new `/kiosk` route sits beside the authed shell and shares its guards through an extracted `AuthGate`; the shell redirects to `/kiosk` while the flag is on. The screen is one `KioskScreen` over small `components/kiosk/*` pieces and pure, unit-tested view helpers in `lib/kiosk-ui.ts`; every action goes through the existing offline-resumable mutations.

**Tech Stack:** React 19, TanStack Router/Query, Tailwind v4 palette blocks, WebCrypto SHA-256, Screen Wake Lock API, bun test (no DOM), Playwright (mobile + tablet projects).

**Spec:** `docs/superpowers/specs/2026-09-08-kiosk-mode-design.md`

## Global Constraints

- No server change: no migration, no endpoint, no `openapi/pjokk.yaml` edit.
- Kiosk logs as the signed-in user (spec 3 changes that); Settings copy says so.
- Palette `.kiosk` declared after `.dark` and before `.night` in `styles.css`; night wins.
- Every kiosk target ≥ 56 px, text ≥ 15 px; no sheet, rail, More, hotkeys on the kiosk.
- Every user-facing literal goes through `t()` with a row in the `nb` dictionary in `apps/frontend/src/lib/i18n.ts` (`node scripts/check-i18n.mjs` enforces it).
- Commits: Conventional Commits with the two trailers
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01C4AJHps9yATdm2FPYtQMnN`.
- Branch `feat/kiosk-mode` (exists, holds the spec). Frontend commands from `apps/frontend`: `bun test`, `bun run typecheck`. Root: `bun run check`, `bun run test`.

---

## File map

| File | Responsibility |
|---|---|
| `apps/frontend/src/lib/kiosk.ts` (new) | device flag + PIN hash store: `useKiosk`, `isKioskOn`, `enableKiosk`, `disableKiosk`, `hashPin`, `verifyPin`, `isValidPin`, `storedPinLength` |
| `apps/frontend/src/lib/kiosk-ui.ts` (new) | pure view helpers: `cautionFor`, `totalsLines`, `sleepCardView`, `feedCardView`, `medicineStripView`, `undoText`, `pinPadReducer` |
| `apps/frontend/src/lib/kiosk-screen.ts` (new) | `useWakeLock`, `useIdle` |
| `apps/frontend/src/styles.css` | `.kiosk` palette |
| `apps/frontend/public/theme-init.js` | `kiosk` class + colour before first paint |
| `apps/frontend/src/lib/system-chrome.ts`, `lib/appearance.tsx` | kiosk colour + class toggle |
| `apps/frontend/src/screens/shell.tsx` | `AuthGate` extracted; kiosk redirect |
| `apps/frontend/src/router.tsx` | `/kiosk` route |
| `apps/frontend/src/components/kiosk/{KioskBand,KioskCard,KioskAction,KioskUndo,KioskMedicineStrip,KioskPinPad,KioskIdleOverlay}.tsx` (new) | the pieces |
| `apps/frontend/src/screens/Kiosk.tsx` (new) | data + mutations + composition |
| `apps/frontend/src/screens/settings/KioskSection.tsx` (new), `settings/index.tsx` | the switch |
| `apps/frontend/src/lib/i18n.ts` | strings |
| `apps/frontend/test/{kiosk,kiosk-ui}.test.ts`, `contrast.test.ts`, `theme-init.test.ts`, `layout-guards.test.ts`, `system-chrome.test.ts` | unit |
| `e2e/kiosk.spec.ts` (new), `e2e/playwright.config.ts` | e2e |
| `DECISIONS.md`, `SMOKE-TEST.md`, `CLAUDE.md` | docs |

---

### Task 1: Device state and PIN (`lib/kiosk.ts`)

**Files:**
- Create: `apps/frontend/src/lib/kiosk.ts`
- Test: `apps/frontend/test/kiosk.test.ts`

**Interfaces (produces):**
```ts
export type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export const PIN_MIN = 4; export const PIN_MAX = 6;
export function isValidPin(pin: string): boolean;
export function hashPin(pin: string): Promise<string>;           // sha256 hex of "pjokk-kiosk:" + pin
export function isKioskOn(storage?: StorageLike): boolean;
export function storedPinLength(storage?: StorageLike): number | null;
export async function enableKiosk(pin: string, storage?: StorageLike): Promise<void>;
export function disableKiosk(storage?: StorageLike): void;
export async function verifyPin(pin: string, storage?: StorageLike): Promise<boolean>;
export function useKiosk(): boolean;                            // useSyncExternalStore
```

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/kiosk.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  disableKiosk,
  enableKiosk,
  hashPin,
  isKioskOn,
  isValidPin,
  storedPinLength,
  verifyPin,
  type StorageLike,
} from "../src/lib/kiosk";

// The kiosk flag and PIN are device state (spec §1). No DOM here, so every
// function takes a storage; the app passes localStorage.
function memory(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("isValidPin", () => {
  it("accepts 4–6 digits and nothing else", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("123456")).toBe(true);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
  });
});

describe("hashPin", () => {
  it("is deterministic, hex, and domain-separated from a bare sha256", async () => {
    const a = await hashPin("1234");
    expect(a).toBe(await hashPin("1234"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // sha256("1234") — must NOT be what we store.
    expect(a).not.toBe(
      "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
    );
  });
});

describe("enable / verify / disable", () => {
  it("round-trips through storage", async () => {
    const s = memory();
    expect(isKioskOn(s)).toBe(false);
    await enableKiosk("2580", s);
    expect(isKioskOn(s)).toBe(true);
    expect(storedPinLength(s)).toBe(4);
    expect(await verifyPin("2580", s)).toBe(true);
    expect(await verifyPin("2581", s)).toBe(false);
    expect(await verifyPin("258", s)).toBe(false);
    disableKiosk(s);
    expect(isKioskOn(s)).toBe(false);
    expect(storedPinLength(s)).toBeNull();
  });

  it("refuses to enable with an invalid PIN", async () => {
    const s = memory();
    await expect(enableKiosk("12", s)).rejects.toThrow();
    expect(isKioskOn(s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it** — `cd apps/frontend && bun test test/kiosk.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/frontend/src/lib/kiosk.ts`:

```ts
import { useSyncExternalStore } from "react";

// Kiosk mode's device state (spec §1): a flag and a PIN hash in
// localStorage, like night mode and the nap guide. The PIN is a convenience
// lock against toddlers and guests, not a security boundary — the tablet
// holds a full session cookie regardless, and spec 3 replaces this with a
// device credential. A tiny external store so the shell can redirect and
// the AppearanceProvider can toggle the `kiosk` class.

export type StorageLike = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

export const ON_KEY = "pjokk.kiosk.on";
export const PIN_KEY = "pjokk.kiosk.pin";
export const PIN_LEN_KEY = "pjokk.kiosk.pinlen";
export const PIN_MIN = 4;
export const PIN_MAX = 6;

const noStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function defaultStorage(): StorageLike {
  try {
    return typeof localStorage === "undefined" ? noStorage : localStorage;
  } catch {
    return noStorage;
  }
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

// Domain-separated so the stored value is never sha256(pin) itself.
export async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`pjokk-kiosk:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isKioskOn(storage: StorageLike = defaultStorage()): boolean {
  try {
    return storage.getItem(ON_KEY) === "1";
  } catch {
    return false;
  }
}

export function storedPinLength(
  storage: StorageLike = defaultStorage(),
): number | null {
  try {
    const n = Number(storage.getItem(PIN_LEN_KEY));
    return Number.isInteger(n) && n >= PIN_MIN && n <= PIN_MAX ? n : null;
  } catch {
    return null;
  }
}

// --- the store -------------------------------------------------------------
let on = isKioskOn();
const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

export async function enableKiosk(
  pin: string,
  storage: StorageLike = defaultStorage(),
): Promise<void> {
  if (!isValidPin(pin)) throw new Error("PIN must be 4–6 digits");
  const hash = await hashPin(pin);
  storage.setItem(PIN_KEY, hash);
  storage.setItem(PIN_LEN_KEY, String(pin.length));
  storage.setItem(ON_KEY, "1");
  on = true;
  notify();
}

export function disableKiosk(storage: StorageLike = defaultStorage()): void {
  storage.removeItem(ON_KEY);
  storage.removeItem(PIN_KEY);
  storage.removeItem(PIN_LEN_KEY);
  on = false;
  notify();
}

export async function verifyPin(
  pin: string,
  storage: StorageLike = defaultStorage(),
): Promise<boolean> {
  const stored = storage.getItem(PIN_KEY);
  if (!stored) return true; // no PIN recorded: nothing to guard
  return (await hashPin(pin)) === stored;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useKiosk(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => on,
    () => false,
  );
}
```

- [ ] **Step 4: Run** — `bun test test/kiosk.test.ts` → PASS (4 tests).
- [ ] **Step 5: Commit** — `git add apps/frontend/src/lib/kiosk.ts apps/frontend/test/kiosk.test.ts && git commit -m "feat(kiosk): device flag and PIN store"`

---

### Task 2: Pure view helpers (`lib/kiosk-ui.ts`)

**Files:**
- Create: `apps/frontend/src/lib/kiosk-ui.ts`
- Test: `apps/frontend/test/kiosk-ui.test.ts`

**Interfaces (produces):**
```ts
export type ReminderLike = { kind: string; mode: string; intervalMin: number | null; babyId: string | null };
export function cautionFor(kind: "feed" | "diaper", lastAt: Date | null, reminders: ReminderLike[], babyId: string, now?: Date): boolean;
export function totalsLines(today: Summary["today"], units: Units): [string, string];
export function sleepCardView(s: { activeSleep: SleepLog | null; lastSleep: SleepLog | null }, now: Date): { state: "awake" | "sleeping" | "none"; headline: string; detail: string };
export function feedCardView(s: { lastFeed: FeedLog | null; activeFeed: FeedTimer | null }, units: Units, now: Date): { live: boolean; headline: string; detail: string };
export function lastBottle(feeds: FeedLog[]): { amountMl: number; contents: FeedContents | null };
export function medicineStripView(e: MedicineCatalogueEntry, now: Date): { show: boolean; okText: string; ahead: boolean };
export type UndoKind = "feed" | "diaper" | "sleep" | "medicine";
export function undoText(kind: UndoKind, detail?: string): string;
export type PinPadState = { digits: string; wrong: number; error: string | null };
export type PinPadEvent = { type: "digit"; d: string } | { type: "backspace" } | { type: "clear" } | { type: "wrong" };
export function pinPadReducer(s: PinPadState, e: PinPadEvent, max: number): PinPadState;
export const PIN_LOCKOUT_MS = 30_000; export const PIN_MAX_WRONG = 3;
```

- [ ] **Step 1: Write the failing test**

`apps/frontend/test/kiosk-ui.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { FeedLog, MedicineCatalogueEntry, SleepLog } from "@pjokk/shared";
import {
  cautionFor,
  feedCardView,
  lastBottle,
  medicineStripView,
  pinPadReducer,
  sleepCardView,
  totalsLines,
  undoText,
} from "../src/lib/kiosk-ui";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-08T14:20:00");

describe("cautionFor (spec §4)", () => {
  const feed3h = { kind: "feed", mode: "since_last", intervalMin: 180, babyId: null };
  it("is off without a reminder", () => {
    expect(cautionFor("feed", at("2026-09-08T10:00:00"), [], "b1", NOW)).toBe(false);
  });
  it("turns on once the interval has elapsed", () => {
    expect(cautionFor("feed", at("2026-09-08T11:21:00"), [feed3h], "b1", NOW)).toBe(false); // 179 min
    expect(cautionFor("feed", at("2026-09-08T11:19:00"), [feed3h], "b1", NOW)).toBe(true); // 181 min
  });
  it("ignores other kinds, at_time reminders and other babies", () => {
    expect(cautionFor("diaper", at("2026-09-08T09:00:00"), [feed3h], "b1", NOW)).toBe(false);
    expect(cautionFor("feed", at("2026-09-08T09:00:00"), [{ ...feed3h, mode: "at_time" }], "b1", NOW)).toBe(false);
    expect(cautionFor("feed", at("2026-09-08T09:00:00"), [{ ...feed3h, babyId: "b2" }], "b1", NOW)).toBe(false);
    expect(cautionFor("feed", at("2026-09-08T09:00:00"), [{ ...feed3h, babyId: "b1" }], "b1", NOW)).toBe(true);
  });
  it("is off with nothing logged yet", () => {
    expect(cautionFor("feed", null, [feed3h], "b1", NOW)).toBe(false);
  });
});

describe("totalsLines", () => {
  it("renders the two band lines", () => {
    expect(
      totalsLines({ feeds: 6, intakeMl: 640, solidsG: 0, wet: 3, dirty: 1, both: 1, dry: 0, sleepMin: 125, sleeps: 2 }, "metric"),
    ).toEqual(["6 feeds · 640 ml", "5 diapers · 2 h 5 min sleep"]);
  });
});

const sleep = (startTime: string, endTime: string | null, location = "crib"): SleepLog =>
  ({ id: "s1", babyId: "b1", caretakerId: "u1", caretakerName: "A", startTime, endTime, location, type: "nap", notes: null }) as unknown as SleepLog;

describe("sleepCardView", () => {
  it("reads awake time from the last sleep's end", () => {
    const v = sleepCardView({ activeSleep: null, lastSleep: sleep("2026-09-08T12:25:00", "2026-09-08T13:10:00") }, NOW);
    expect(v.state).toBe("awake");
    expect(v.headline).toBe("1 h 10 min");
    expect(v.detail).toContain("45 min");
    expect(v.detail).toContain("crib");
  });
  it("reads the running session while sleeping", () => {
    const v = sleepCardView({ activeSleep: sleep("2026-09-08T13:35:00", null), lastSleep: null }, NOW);
    expect(v.state).toBe("sleeping");
    expect(v.headline).toBe("45 min");
    expect(v.detail).toContain("13:35");
  });
  it("copes with nothing logged", () => {
    expect(sleepCardView({ activeSleep: null, lastSleep: null }, NOW).state).toBe("none");
  });
});

const feed = (time: string, amountMl: number, contents: "formula" | null = "formula"): FeedLog =>
  ({ id: "f1", babyId: "b1", caretakerId: "u1", caretakerName: "A", time, type: "bottle", amountMl, side: null, durationMin: null, contents, food: null, reaction: null, notes: null }) as unknown as FeedLog;

describe("feedCardView / lastBottle", () => {
  it("shows the last feed as elapsed + amount", () => {
    const v = feedCardView({ lastFeed: feed("2026-09-08T12:48:00", 120), activeFeed: null }, "metric", NOW);
    expect(v.live).toBe(false);
    expect(v.headline).toBe("1 h 32 min");
    expect(v.detail).toContain("120 ml");
  });
  it("prefers the last bottle for the quick action, defaulting to 120", () => {
    expect(lastBottle([feed("2026-09-08T12:48:00", 90, null)])).toEqual({ amountMl: 90, contents: null });
    expect(lastBottle([])).toEqual({ amountMl: 120, contents: null });
  });
});

const entry = (lastDoseAt: string | null, minIntervalMin: number | null): MedicineCatalogueEntry =>
  ({ id: "m1", name: "Paracetamol", defaultAmount: 2.5, unit: "ml", minIntervalMin, isSupplement: false, archived: false, lastDoseAt });

describe("medicineStripView (spec §5)", () => {
  it("shows a dose whose interval is still running, with 'OK from'", () => {
    const v = medicineStripView(entry("2026-09-08T11:40:00", 240), NOW);
    expect(v.show).toBe(true);
    expect(v.ahead).toBe(true);
    expect(v.okText).toBe("OK from 15:40");
  });
  it("shows a dose from the last 24 h even once the interval passed, with 'OK now'", () => {
    const v = medicineStripView(entry("2026-09-08T08:00:00", 240), NOW);
    expect(v.show).toBe(true);
    expect(v.ahead).toBe(false);
    expect(v.okText).toBe("OK now");
  });
  it("hides an entry with no dose in the last 24 h", () => {
    expect(medicineStripView(entry("2026-09-06T08:00:00", 240), NOW).show).toBe(false);
    expect(medicineStripView(entry(null, 240), NOW).show).toBe(false);
  });
});

describe("undoText", () => {
  it("names what was logged", () => {
    expect(undoText("diaper", "wet")).toBe("Wet diaper logged");
    expect(undoText("feed", "120 ml")).toBe("Bottle 120 ml logged");
    expect(undoText("sleep")).toBe("Sleep started");
    expect(undoText("medicine", "Paracetamol")).toBe("Paracetamol logged");
  });
});

describe("pinPadReducer (spec §6)", () => {
  const s0 = { digits: "", wrong: 0, error: null };
  it("collects digits up to the length and backspaces", () => {
    let s = pinPadReducer(s0, { type: "digit", d: "1" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "2" }, 4);
    expect(s.digits).toBe("12");
    s = pinPadReducer(s, { type: "backspace" }, 4);
    expect(s.digits).toBe("1");
    s = pinPadReducer(s, { type: "digit", d: "2" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "3" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "4" }, 4);
    s = pinPadReducer(s, { type: "digit", d: "5" }, 4);
    expect(s.digits).toBe("1234");
  });
  it("a wrong PIN clears, counts and shows the message", () => {
    const s = pinPadReducer({ digits: "1234", wrong: 1, error: null }, { type: "wrong" }, 4);
    expect(s).toEqual({ digits: "", wrong: 2, error: "Wrong PIN" });
  });
  it("typing again clears the message", () => {
    const s = pinPadReducer({ digits: "", wrong: 2, error: "Wrong PIN" }, { type: "digit", d: "9" }, 4);
    expect(s.error).toBeNull();
    expect(s.wrong).toBe(2);
  });
});
```

- [ ] **Step 2: Run it** — FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/frontend/src/lib/kiosk-ui.ts`:

```ts
import type {
  FeedContents,
  FeedLog,
  FeedTimer,
  MedicineCatalogueEntry,
  SleepLog,
  Summary,
} from "@pjokk/shared";
import { clock, totalSeconds } from "./feed-timer-ui";
import { t } from "./i18n";
import { nextDoseFrom } from "./medicine-ui";
import { formatClock, formatDuration, formatElapsed } from "./time";
import { formatVolume, type Units } from "./units";

// Pure view logic for the care station (spec §4–§6): what each card and
// strip says, when a card turns amber, what the undo toast reads, and the
// PIN pad's state machine. No React, no DOM — test/kiosk-ui.test.ts.

export type ReminderLike = {
  kind: string;
  mode: string;
  intervalMin: number | null;
  babyId: string | null;
};

// Amber when the signed-in user's own since_last reminder for this kind
// has elapsed — the family's threshold, exactly as the push nudge uses it.
// No reminder, no amber.
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

export function totalsLines(
  today: Summary["today"],
  units: Units,
): [string, string] {
  const diapers = today.wet + today.dirty + today.both + today.dry;
  return [
    `${today.feeds} ${t("feeds")} · ${formatVolume(today.intakeMl, units)}`,
    `${diapers} ${t("diapers")} · ${formatDuration(today.sleepMin * 60_000)} ${t("sleep")}`,
  ];
}

export function sleepCardView(
  s: { activeSleep: SleepLog | null; lastSleep: SleepLog | null },
  now: Date,
): { state: "awake" | "sleeping" | "none"; headline: string; detail: string } {
  if (s.activeSleep) {
    const start = new Date(s.activeSleep.startTime);
    return {
      state: "sleeping",
      headline: formatElapsed(start, now),
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
      headline: formatElapsed(end, now),
      detail: [
        `${t("after a")} ${formatDuration(end.getTime() - start.getTime())} ${t("nap")}`,
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
  if (!f) return { live: false, headline: "—", detail: t("No feed logged yet") };
  const what =
    f.type === "bottle"
      ? [f.amountMl != null ? formatVolume(f.amountMl, units) : null, f.contents ? t(f.contents) : null]
          .filter(Boolean)
          .join(" ")
      : f.type === "breast"
        ? [t("breast"), f.side, f.durationMin ? `${f.durationMin} min` : null].filter(Boolean).join(" ")
        : t("solids");
  return {
    live: false,
    headline: formatElapsed(new Date(f.time), now),
    detail: `${t("ago")} · ${what}`,
  };
}

// The quick Bottle action logs the last bottle again (last-value prefill).
export function lastBottle(feeds: FeedLog[]): {
  amountMl: number;
  contents: FeedContents | null;
} {
  const last = feeds.find((f) => f.type === "bottle");
  return { amountMl: last?.amountMl ?? 120, contents: last?.contents ?? null };
}

const DAY_MS = 24 * 60 * 60_000;

export function medicineStripView(
  e: MedicineCatalogueEntry,
  now: Date,
): { show: boolean; okText: string; ahead: boolean } {
  if (e.archived || !e.lastDoseAt) return { show: false, okText: "", ahead: false };
  const last = new Date(e.lastDoseAt);
  const next = nextDoseFrom(e, now);
  const ahead = !!next && next.getTime() > now.getTime();
  const recent = now.getTime() - last.getTime() < DAY_MS;
  if (!ahead && !recent) return { show: false, okText: "", ahead: false };
  return {
    show: true,
    ahead,
    okText: ahead && next ? `${t("OK from")} ${formatClock(next)}` : t("OK now"),
  };
}

export type UndoKind = "feed" | "diaper" | "sleep" | "medicine";

export function undoText(kind: UndoKind, detail?: string): string {
  switch (kind) {
    case "diaper":
      return `${t(capitalize(detail ?? "diaper"))} ${t("diaper logged")}`;
    case "feed":
      return `${t("Bottle")} ${detail ?? ""} ${t("logged")}`.replace(/\s+/g, " ");
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

export type PinPadState = { digits: string; wrong: number; error: string | null };
export type PinPadEvent =
  | { type: "digit"; d: string }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "wrong" };

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
  }
}
```

  Dictionary rows to add in `lib/i18n.ts` (next to `Account: "Konto",`):

```ts
  "after a": "etter en",
  "No sleep logged yet": "Ingen søvn logget ennå",
  "No feed logged yet": "Intet måltid logget ennå",
  "left side": "venstre side",
  "right side": "høyre side",
  paused: "pauset",
  ago: "siden",
  breast: "bryst",
  "OK from": "OK fra",
  "OK now": "OK nå",
  "diaper logged": "bleie logget",
  logged: "logget",
  "Sleep started": "Søvn startet",
  Medicine: "Medisin",
  "Wrong PIN": "Feil PIN",
  Wet: "Våt",
  Dirty: "Skitten",
  Both: "Begge",
```

  (Check which already exist with `grep -n '^\s*\(Wet\|Dirty\|Both\|Medicine\|ago\|breast\):' apps/frontend/src/lib/i18n.ts` and skip duplicates — biome refuses duplicate keys.)

- [ ] **Step 4: Run** — `bun test test/kiosk-ui.test.ts` → PASS. If `feeds`/`diapers`/`sleep` keys render Norwegian in the test, the language is `en` by default in tests (no localStorage) — they render English.
- [ ] **Step 5: Commit** — `git add apps/frontend/src/lib/kiosk-ui.ts apps/frontend/src/lib/i18n.ts apps/frontend/test/kiosk-ui.test.ts && git commit -m "feat(kiosk): pure view helpers for the care station"`

---

### Task 3: Palette, boot class, chrome colour

**Files:**
- Modify: `apps/frontend/src/styles.css` (add `.kiosk` between `.dark` and `.night`)
- Modify: `apps/frontend/public/theme-init.js`
- Modify: `apps/frontend/src/lib/system-chrome.ts`, `apps/frontend/src/lib/appearance.tsx`
- Test: `apps/frontend/test/contrast.test.ts`, `test/theme-init.test.ts`, `test/system-chrome.test.ts`

- [ ] **Step 1: Extend the tests**

  In `test/contrast.test.ts` after `const night = ...` add `const kiosk = { ...light, ...tokens(blockAfter(".kiosk")) };` and add `["kiosk", kiosk],` to `themes`.

  In `test/theme-init.test.ts`: add `kiosk?: boolean` to `Env`, add `"pjokk.kiosk.on": env.kiosk ? "1" : null,` to `stored`, and append:

```ts
  it("applies the kiosk class and colour before the paint", () => {
    const r = runInit({ theme: "light", kiosk: true });
    expect(r.classes).toContain("kiosk");
    expect(r.color).toBe(SYSTEM_CHROME_KIOSK);
  });
  it("kiosk at night carries both classes and night's colour", () => {
    const r = runInit({ theme: "light", kiosk: true, nightMode: "on" });
    expect(r.classes).toContain("kiosk");
    expect(r.classes).toContain("night");
    expect(r.color).toBe(SYSTEM_CHROME_NIGHT);
  });
```
  and import `SYSTEM_CHROME_KIOSK` from `../src/lib/system-chrome`.

  In `test/system-chrome.test.ts` append:
```ts
  it("reports the kiosk background while kiosk is on, unless it is night", () => {
    expect(systemChromeColor({ night: false, dark: false, standalone: false, kiosk: true })).toBe(SYSTEM_CHROME_KIOSK);
    expect(systemChromeColor({ night: true, dark: false, standalone: false, kiosk: true })).toBe(SYSTEM_CHROME_NIGHT);
  });
```
  (import `SYSTEM_CHROME_KIOSK`; existing calls without `kiosk` keep working because the field is optional.)

- [ ] **Step 2: Run** — `bun test test/contrast.test.ts test/theme-init.test.ts test/system-chrome.test.ts` → FAIL (no `.kiosk` block, no export).

- [ ] **Step 3: Implement**

  `styles.css`, after the `.dark { ... }` block and before `/* Night mode`:

```css
/* Kiosk mode (spec §3): the care station's own palette — cool, dark, one
   mint accent, a different hue from the warm dark mode and from the amber
   night ramp so the state reads from across the room. Declared after .dark
   (wins over it) and before .night (loses to it at 22:00). Checked by
   test/contrast.test.ts like the other three. */
.kiosk {
  --color-bg: #131a21;
  --color-surface: #1b242d;
  --color-surface-2: #253039;
  --color-ink: #e8eef2;
  --color-ink-soft: #b7c3cc;
  --color-muted: #8a98a3;
  --color-line: #2b3640;
  --color-accent: #7fd6b5;
  --color-accent-soft: #1d3a31;
  --color-on-accent: #0f1a17;
  --color-danger: #e08a7e;
  --color-ok: #6fcf97;
  --color-caution: #e0a94a;
  --color-sleep: #a294e6;
  --color-feed: #7fb3e8;
  --color-diaper: #56c6b9;
  --color-growth: #efa07e;
}
```

  `system-chrome.ts`: add `export const SYSTEM_CHROME_KIOSK = "#131a21";`, add `kiosk?: boolean` to `SystemChromeEnv`, and make `systemChromeColor` `if (night) return NIGHT; if (kiosk) return KIOSK; ...`.

  `theme-init.js`: after `el.classList.toggle("night", night);` add
```js
    // Kiosk mode (lib/kiosk.ts): the care station's own palette, before
    // the first paint like the other two.
    const kiosk = localStorage.getItem("pjokk.kiosk.on") === "1";
    el.classList.toggle("kiosk", kiosk);
```
  and change the colour expression to `night ? "#171310" : kiosk ? "#131a21" : dark || standalone ? "#171512" : "#faf9f7"`.

  `appearance.tsx`: `import { useKiosk } from "./kiosk";`; inside the provider `const kiosk = useKiosk();`, an effect `document.documentElement.classList.toggle("kiosk", kiosk)`, and pass `kiosk` into `systemChromeColor({...})` (add it to that effect's deps). Expose `kiosk` on the context value (`AppearanceValue` gains `kiosk: boolean`).

- [ ] **Step 4: Run** — the three test files PASS; `bun run typecheck` clean. If a kiosk token fails a contrast floor, darken the background or lighten the token until it passes — do not lower the floor.
- [ ] **Step 5: Commit** — `git commit -m "feat(kiosk): slate palette, boot class and chrome colour"`

---

### Task 4: Route, AuthGate, redirect

**Files:**
- Modify: `apps/frontend/src/screens/shell.tsx`
- Modify: `apps/frontend/src/router.tsx`
- Create: `apps/frontend/src/screens/Kiosk.tsx` (placeholder that Task 5 fills: renders `<KioskScreen />` with the band only)
- Test: `apps/frontend/test/layout-guards.test.ts`

- [ ] **Step 1: Extend the guard test**

```ts
  it("the kiosk never imports the app's sheets, nav or hotkeys", () => {
    const files = [...walk(join(SRC, "components", "kiosk")), join(SRC, "screens", "Kiosk.tsx")];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      for (const banned of ["components/Sheet", "components/TabBar", "components/HomeActions", "lib/hotkeys"]) {
        expect(src, `${p} imports ${banned}`).not.toContain(banned);
      }
    }
  });
```
  It fails until `components/kiosk` exists (readdirSync throws) — create the directory with the first component in Task 5; for now create `screens/Kiosk.tsx` and an empty `components/kiosk/.gitkeep` is NOT acceptable (biome ignores it but walk returns nothing). Create `components/kiosk/KioskBand.tsx` in this task (its final form is in Task 5, Step 3; write it now).

- [ ] **Step 2: shell.tsx — extract AuthGate, add the redirect**

  Replace `export function AppShell()` with:

```tsx
// Session + family guard shared by the app shell and the kiosk (spec §2).
// Renders `children` only once the session is known and the family is
// settled; otherwise the same blank / login / welcome handling as before.
export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const me = useMe();
  const familyId = me.data?.familyId ?? null;
  useEffect(() => {
    // (the existing family-fence effect, verbatim)
  }, [familyId]);
  useEffect(() => {
    // (the existing discarded-toast effect, verbatim)
  }, []);
  if (isPending || me.isPending || !me.isFetchedAfterMount) {
    return <div className="min-h-dvh" />;
  }
  if (!session) return <Navigate to="/login" />;
  if (!me.data?.familyId) return <Navigate to="/welcome" />;
  return <>{children}</>;
}

export function AppShell() {
  return (
    <AuthGate>
      <AppChrome />
    </AuthGate>
  );
}

// While kiosk is on, the device IS the kiosk: every app route lands on the
// care station (a reload, a manifest shortcut, a push action). /login,
// /join, /welcome and /admin are outside this shell and untouched.
function AppChrome() {
  const me = useMe();
  const kiosk = useKiosk();
  if (kiosk) return <Navigate to="/kiosk" />;
  const { impersonatedBy, name } = me.data ?? {};
  const stopImpersonating = async () => { /* existing body verbatim */ };
  return ( /* the existing returned tree verbatim */ );
}
```
  Add `import { useKiosk } from "@/lib/kiosk";` and `type ReactNode` to the react import.

- [ ] **Step 3: router.tsx** — after `adminRoute` definitions, add and register:

```tsx
// The care station (spec: kiosk mode). A sibling of the authed shell, not
// a child: it shares the guards through AuthGate but has no tab bar, no
// rail and no width cap.
const kioskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kiosk",
  component: lazyRouteComponent(() => import("@/screens/Kiosk"), "KioskRoute"),
});
```
  and add `kioskRoute` to the `rootRoute.addChildren([...])` list.

- [ ] **Step 4: screens/Kiosk.tsx (first cut)**

```tsx
import { AuthGate } from "@/screens/shell";
import { KioskBand } from "@/components/kiosk/KioskBand";
// Filled in by the next task.
export function KioskRoute() {
  return (
    <AuthGate>
      <KioskScreen />
    </AuthGate>
  );
}
export function KioskScreen() {
  return <div className="min-h-dvh bg-bg text-ink" />;
}
```

- [ ] **Step 5: Run** — `bun run check` clean; `bun test` PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(kiosk): /kiosk route, AuthGate extracted from the shell, kiosk redirect"`

---

### Task 5: The screen

**Files:**
- Create: `apps/frontend/src/lib/kiosk-screen.ts`
- Create: `apps/frontend/src/components/kiosk/KioskBand.tsx`, `KioskCard.tsx`, `KioskAction.tsx`, `KioskUndo.tsx`, `KioskMedicineStrip.tsx`, `KioskPinPad.tsx`, `KioskIdleOverlay.tsx`
- Modify: `apps/frontend/src/screens/Kiosk.tsx`
- Modify: `apps/frontend/src/lib/i18n.ts`

**Interfaces (consumes):** Task 1 store, Task 2 helpers, existing hooks `useSummary`, `useFeeds`, `useSleepLocations`, `useReminders`, `useMedicineCatalogue`, `useLogFeed`, `useLogDiaper`, `useStartSleep`, `useWakeSleep`, `useStartFeedTimer`, `useSetFeedTimerSide`, `useStopFeedTimer`, `useCreateOther`, `useDeleteFeed`, `useDeleteDiaper`, `useDeleteSleep`, `useDeleteOther`, `useUnits`, `useAppearance`, `useNapGuide`, `napWindow`, `describeNapWindow`, `sleepTypeAt`, `formatClock`, `formatAge`, `formatDay`.

- [ ] **Step 1: `lib/kiosk-screen.ts`**

```ts
import { useEffect, useState } from "react";

// Screen behaviour for the care station (spec §7).

// Keeps the display on while the kiosk is mounted; re-requests after the
// tab was hidden (the lock is released then). Absent API: nothing.
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        // denied (low battery, not visible): try again on the next visibility change
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [enabled]);
}

export const IDLE_MS = 120_000;
// How long the overlay keeps swallowing pointer events after the wake tap,
// so that tap can never also press what was underneath.
export const WAKE_SWALLOW_MS = 350;

export type IdleState = "awake" | "dim" | "waking";

export function useIdle(ms = IDLE_MS): [IdleState, () => void] {
  const [state, setState] = useState<IdleState>("awake");
  useEffect(() => {
    let timer = setTimeout(() => setState("dim"), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setState("dim"), ms);
    };
    window.addEventListener("pointerdown", reset, true);
    window.addEventListener("keydown", reset, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("keydown", reset, true);
    };
  }, [ms]);
  const wake = () => {
    setState("waking");
    setTimeout(() => setState("awake"), WAKE_SWALLOW_MS);
  };
  return [state, wake];
}
```

- [ ] **Step 2: Components**

`KioskAction.tsx`:
```tsx
import { cn, focusRing } from "@/lib/utils";

// A quick action inside a card (spec §4): 56 px, one tap logs.
export function KioskAction({ label, hint, primary = false, disabled = false, onClick }: {
  label: string; hint?: string; primary?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-14 min-w-0 flex-1 flex-col items-center justify-center rounded-2xl border px-2 text-base font-bold whitespace-nowrap select-none active:scale-[0.97] disabled:opacity-40",
        primary ? "border-accent bg-accent text-on-accent" : "border-line bg-surface-2 text-ink",
        focusRing,
      )}
    >
      <span className="truncate">{label}</span>
      {hint && <span className="text-xs font-medium opacity-75">{hint}</span>}
    </button>
  );
}
```

`KioskCard.tsx`:
```tsx
import type { Icon as TablerIcon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

// One activity card (spec §4): icon + label, the elapsed time at 48 px,
// a detail line, a totals sub-line, the quick actions. `tone` caution =
// the reminder interval has elapsed; live = a session or timer is running.
export function KioskCard({ icon: Icon, tint, label, headline, detail, sub, tone = "normal", children, testId }: {
  icon: TablerIcon; tint: string; label: string; headline: string; detail: string; sub?: string | null;
  tone?: "normal" | "caution" | "live"; children: ReactNode; testId: string;
}) {
  const caution = tone === "caution";
  return (
    <section
      data-testid={testId}
      data-tone={tone}
      className={cn("flex min-h-[280px] flex-col gap-4 rounded-3xl border bg-surface p-5", caution ? "border-caution" : "border-line")}
    >
      <div className="flex items-center gap-3">
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2", caution ? "text-caution" : tint)}>
          <Icon className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold tracking-[.08em] text-muted uppercase">{label}</span>
        {tone === "live" && (
          <span className="ml-auto rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-extrabold tracking-wider text-on-accent uppercase">{t("live")}</span>
        )}
      </div>
      <div className="space-y-1">
        <p className={cn("text-5xl font-extrabold tabular-nums tracking-tight", caution ? "text-caution" : tone === "live" ? "text-accent" : "text-ink")}>{headline}</p>
        <p className="text-[17px] font-medium text-ink-soft">{detail}</p>
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      <div className="flex-1" />
      <div className="flex gap-2">{children}</div>
    </section>
  );
}
```

`KioskBand.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import type { Baby } from "@pjokk/shared";
import { t } from "@/lib/i18n";
import { formatAge, formatClock, formatDay } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

export const HOLD_MS = 1500;

// The top band (spec §4): name + date left (the name is the press-and-hold
// target for leaving), the clock in the middle, today's totals right.
export function KioskBand({ baby, now, totals, onHold, holdDisabled = false }: {
  baby: Baby; now: Date; totals: [string, string] | null; onHold: () => void; holdDisabled?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const start = () => {
    if (holdDisabled) return;
    setHolding(true);
    timer.current = setTimeout(() => { setHolding(false); onHold(); }, HOLD_MS);
  };
  const stop = () => {
    setHolding(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 pt-5">
      <div className="min-w-0">
        <button
          type="button"
          aria-label={t("Hold to leave kiosk mode")}
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={cn("block max-w-full truncate rounded-xl text-left text-[26px] leading-8 font-extrabold text-ink select-none", holding && "opacity-60", focusRing)}
        >
          {baby.name}
        </button>
        <p className="truncate text-sm font-semibold tracking-[.12em] text-muted uppercase">
          {formatDay(now)} · {formatAge(new Date(baby.birthDate))}
        </p>
      </div>
      <time className="text-7xl leading-none font-light tracking-tight tabular-nums text-ink" data-testid="kiosk-clock">
        {formatClock(now)}
      </time>
      <div className="min-w-0 text-right text-[15px] leading-5 text-ink-soft">
        {totals && (<><p className="truncate">{totals[0]}</p><p className="truncate">{totals[1]}</p></>)}
      </div>
    </header>
  );
}
```

`KioskUndo.tsx`:
```tsx
import { IconCheck } from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import { cn, focusRing } from "@/lib/utils";

export const UNDO_MS = 6000;

// The undo toast (spec §4): the kiosk's own — it needs a button and a
// longer life than lib/toast.ts gives.
export function KioskUndo({ text, onUndo }: { text: string; onUndo: () => void }) {
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-4 rounded-full bg-ink py-3 pr-3 pl-5 text-base font-semibold text-bg shadow-lg">
        <IconCheck className="h-5 w-5 text-accent" />
        {text}
        <button type="button" onClick={onUndo} className={cn("flex h-10 items-center rounded-full bg-black/20 px-4 font-extrabold", focusRing)}>
          {t("Undo")}
        </button>
      </div>
    </div>
  );
}
```

`KioskMedicineStrip.tsx`:
```tsx
import { IconPill } from "@tabler/icons-react";
import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { t } from "@/lib/i18n";
import { medicineStripView } from "@/lib/kiosk-ui";
import { formatClock } from "@/lib/time";
import { cn, focusRing } from "@/lib/utils";

export function KioskMedicineStrip({ entry, now, onLog }: { entry: MedicineCatalogueEntry; now: Date; onLog: () => void }) {
  const v = medicineStripView(entry, now);
  if (!v.show) return null;
  const dose = entry.defaultAmount != null ? `${entry.defaultAmount} ${entry.unit ?? ""}`.trim() : null;
  return (
    <div data-testid="kiosk-medicine" className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-growth"><IconPill className="h-[18px] w-[18px]" /></span>
      <p className="min-w-0 flex-1 truncate text-[17px] text-ink">
        <span className="font-bold">{entry.name}</span>
        <span className="text-ink-soft"> · {t("last dose")} {entry.lastDoseAt ? formatClock(new Date(entry.lastDoseAt)) : "—"}{dose ? ` · ${dose}` : ""} · </span>
        <span className={cn("font-bold", v.ahead ? "text-accent" : "text-ink")}>{v.okText}</span>
      </p>
      {dose && (
        <button type="button" onClick={onLog} className={cn("flex h-11 items-center rounded-xl border border-line bg-surface-2 px-4 text-[15px] font-bold text-ink active:scale-[0.97]", focusRing)}>
          {t("Log dose")}
        </button>
      )}
    </div>
  );
}
```

`KioskIdleOverlay.tsx`:
```tsx
import type { IdleState } from "@/lib/kiosk-screen";
import { cn } from "@/lib/utils";

// 60 % black after two idle minutes; the wake tap lands here and nowhere
// else (spec §7). "waking" keeps swallowing for a few hundred ms.
export function KioskIdleOverlay({ state, onWake }: { state: IdleState; onWake: () => void }) {
  if (state === "awake") return null;
  return (
    <div
      data-testid="kiosk-idle"
      onPointerDown={(e) => { e.stopPropagation(); if (state === "dim") onWake(); }}
      onClick={(e) => e.stopPropagation()}
      className={cn("fixed inset-0 z-40 bg-black transition-opacity duration-1000", state === "dim" ? "opacity-60" : "opacity-0")}
    />
  );
}
```

`KioskPinPad.tsx`:
```tsx
import { IconBackspace, IconLock } from "@tabler/icons-react";
import { useEffect, useReducer } from "react";
import { t } from "@/lib/i18n";
import { verifyPin } from "@/lib/kiosk";
import { PIN_MAX_WRONG, pinPadReducer, type PinPadState } from "@/lib/kiosk-ui";
import { cn, focusRing } from "@/lib/utils";

// Leaving kiosk (spec §6): dots, a 3×4 keypad, Cancel. Verifies on the
// stored PIN's length; three wrong in a row hands a lockout to the screen.
export function KioskPinPad({ length, onSuccess, onCancel, onLockout }: {
  length: number; onSuccess: () => void; onCancel: () => void; onLockout: () => void;
}) {
  const [s, dispatch] = useReducer(
    (st: PinPadState, e: Parameters<typeof pinPadReducer>[1]) => pinPadReducer(st, e, length),
    { digits: "", wrong: 0, error: null },
  );
  useEffect(() => {
    if (s.digits.length !== length) return;
    let cancelled = false;
    void verifyPin(s.digits).then((ok) => {
      if (cancelled) return;
      if (ok) onSuccess();
      else if (s.wrong + 1 >= PIN_MAX_WRONG) onLockout();
      else dispatch({ type: "wrong" });
    });
    return () => { cancelled = true; };
  }, [s.digits, s.wrong, length, onSuccess, onLockout]);
  const key = (k: string) => (
    <button key={k} type="button" onClick={() => dispatch({ type: "digit", d: k })} className={cn("flex h-[72px] w-[72px] items-center justify-center rounded-full border border-line bg-surface-2 text-[26px] font-bold text-ink active:scale-95", focusRing)}>{k}</button>
  );
  return (
    <div role="dialog" aria-label={t("Leave kiosk mode")} className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="flex w-[360px] flex-col items-center gap-5 rounded-3xl border border-line bg-bg px-8 pt-7 pb-6">
        <div className="flex flex-col items-center gap-1.5">
          <IconLock className="h-7 w-7 text-accent" />
          <p className="text-lg font-bold text-ink">{t("Leave kiosk mode")}</p>
          <p className="text-sm text-muted">{s.error ?? t("Enter the kiosk PIN")}</p>
        </div>
        <div className={cn("flex gap-3.5", s.error && "animate-pulse-soft")} aria-label={t("PIN")}>
          {Array.from({ length }, (_, i) => (
            <span key={i} className={cn("h-3.5 w-3.5 rounded-full border-2 border-accent", i < s.digits.length && "bg-accent")} />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3.5">
          {["1","2","3","4","5","6","7","8","9"].map(key)}
          <span />
          {key("0")}
          <button type="button" aria-label={t("Backspace")} onClick={() => dispatch({ type: "backspace" })} className={cn("flex h-[72px] w-[72px] items-center justify-center rounded-full text-ink-soft", focusRing)}><IconBackspace className="h-[26px] w-[26px]" /></button>
        </div>
        <button type="button" onClick={onCancel} className={cn("h-11 px-4 text-sm font-semibold text-muted", focusRing)}>{t("Cancel")}</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `screens/Kiosk.tsx`**

```tsx
import { IconBabyBottle, IconDiaper, IconMoon } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { MedicineCatalogueEntry } from "@pjokk/shared";
import { KioskAction } from "@/components/kiosk/KioskAction";
import { KioskBand } from "@/components/kiosk/KioskBand";
import { KioskCard } from "@/components/kiosk/KioskCard";
import { KioskIdleOverlay } from "@/components/kiosk/KioskIdleOverlay";
import { KioskMedicineStrip } from "@/components/kiosk/KioskMedicineStrip";
import { KioskPinPad } from "@/components/kiosk/KioskPinPad";
import { KioskUndo, UNDO_MS } from "@/components/kiosk/KioskUndo";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/QueryStates";
import { useAppearance } from "@/lib/appearance";
import {
  useCreateOther, useDeleteDiaper, useDeleteFeed, useDeleteOther, useDeleteSleep, useFeeds,
  useLogDiaper, useLogFeed, useMedicineCatalogue, useReminders, useSetFeedTimerSide,
  useSleepLocations, useStartFeedTimer, useStartSleep, useStopFeedTimer, useSummary, useWakeSleep,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { disableKiosk, storedPinLength } from "@/lib/kiosk";
import { useIdle, useWakeLock } from "@/lib/kiosk-screen";
import { PIN_LOCKOUT_MS, cautionFor, feedCardView, lastBottle, sleepCardView, totalsLines, undoText, type UndoKind } from "@/lib/kiosk-ui";
import { describeNapWindow, napWindow, useNapGuide } from "@/lib/nap-window";
import { sleepTypeAt } from "@/lib/night";
import { useSelectedBaby } from "@/lib/selected-baby";
import { formatVolume, useUnits } from "@/lib/units";
import { AuthGate } from "@/screens/shell";

// The care station (spec). Everything here already exists in the API: the
// screen is Home's data with one-tap actions on the cards and an Undo.
export function KioskRoute() {
  return (
    <AuthGate>
      <KioskScreen />
    </AuthGate>
  );
}

type Undo = { kind: UndoKind; id: string; text: string };

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function KioskScreen() {
  const navigate = useNavigate();
  const { babies, baby } = useSelectedBaby();
  const summary = useSummary(baby?.id);
  const feeds = useFeeds(baby?.id);
  const locations = useSleepLocations();
  const reminders = useReminders();
  const catalogue = useMedicineCatalogue(baby?.id, !!baby);
  const units = useUnits();
  const { night } = useAppearance();
  const napGuide = useNapGuide();
  // A second tick while a nursing timer runs, half a minute otherwise.
  const now = useNow(summary.data?.activeFeed ? 1000 : 30_000);

  useWakeLock();
  const [idle, wake] = useIdle();

  const logFeed = useLogFeed();
  const logDiaper = useLogDiaper();
  const startSleep = useStartSleep();
  const wakeSleep = useWakeSleep();
  const startTimer = useStartFeedTimer();
  const switchSide = useSetFeedTimerSide();
  const stopTimer = useStopFeedTimer();
  const createOther = useCreateOther();
  const delFeed = useDeleteFeed();
  const delDiaper = useDeleteDiaper();
  const delSleep = useDeleteSleep();
  const delOther = useDeleteOther();

  const [undo, setUndo] = useState<Undo | null>(null);
  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [undo]);
  const doUndo = () => {
    if (!undo) return;
    if (undo.kind === "feed") delFeed.mutate({ id: undo.id });
    if (undo.kind === "diaper") delDiaper.mutate({ id: undo.id });
    if (undo.kind === "sleep") delSleep.mutate({ id: undo.id });
    if (undo.kind === "medicine") delOther.mutate({ kind: "medicine", id: undo.id });
    setUndo(null);
  };

  const [pad, setPad] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const leave = useCallback(() => {
    disableKiosk();
    void navigate({ to: "/home" });
  }, [navigate]);
  const lockout = useCallback(() => {
    setPad(false);
    setLockedUntil(Date.now() + PIN_LOCKOUT_MS);
  }, []);

  if (babies.isError) return <div className="flex min-h-dvh flex-col justify-center bg-bg"><ErrorState onRetry={() => void babies.refetch()} /></div>;
  if (!baby) {
    if (babies.isSuccess) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-8 text-center text-ink">
          <p className="text-lg font-bold">{t("No baby yet")}</p>
          <Button variant="outline" onClick={() => setPad(true)}>{t("Leave kiosk mode")}</Button>
          {pad && <KioskPinPad length={storedPinLength() ?? 4} onSuccess={leave} onCancel={() => setPad(false)} onLockout={lockout} />}
        </div>
      );
    }
    return <div className="flex min-h-dvh flex-col justify-center bg-bg"><LoadingState /></div>;
  }

  const s = summary.data;
  const babyId = baby.id;
  const iso = () => new Date().toISOString();
  const rem = reminders.data ?? [];
  const sleepView = sleepCardView({ activeSleep: s?.activeSleep ?? null, lastSleep: s?.lastSleep ?? null }, now);
  const feedView = feedCardView({ lastFeed: s?.lastFeed ?? null, activeFeed: s?.activeFeed ?? null }, units, now);
  const bottle = lastBottle(feeds.data ?? []);
  const feedCaution = !feedView.live && cautionFor("feed", s?.lastFeed ? new Date(s.lastFeed.time) : null, rem, babyId, now);
  const diaperCaution = cautionFor("diaper", s?.lastDiaper ? new Date(s.lastDiaper.time) : null, rem, babyId, now);
  const nap = napGuide && s?.lastSleep?.endTime && !s.activeSleep
    ? napWindow({ birthDate: new Date(baby.birthDate), wakeAt: new Date(s.lastSleep.endTime), now })
    : null;
  const lastLocation = s?.lastSleep?.location ?? s?.activeSleep?.location ?? null;
  const otherLocations = (locations.data ?? []).map((l) => l.name).filter((n) => n !== lastLocation).slice(0, 2);
  const medicines: MedicineCatalogueEntry[] = (catalogue.data ?? []).filter((m) => !m.archived);

  return (
    <div className="min-h-dvh bg-bg px-6 pt-safe pb-safe text-ink md:px-8">
      <KioskBand baby={baby} now={now} totals={night || !s ? null : totalsLines(s.today, units)} onHold={() => setPad(true)} holdDisabled={Date.now() < lockedUntil} />
      {!night && nap && (
        <p className="pt-2.5 text-center text-lg font-semibold text-accent" data-testid="kiosk-nap">{describeNapWindow(nap)}</p>
      )}
      <div className="grid gap-3.5 pt-5 md:grid-cols-3">
        <KioskCard testId="kiosk-sleep" icon={IconMoon} tint="text-sleep"
          label={sleepView.state === "sleeping" ? t("Sleeping") : t("Awake")}
          headline={sleepView.headline} detail={sleepView.detail}
          sub={night || !s ? null : `${s.today.sleeps} ${s.today.sleeps === 1 ? t("nap") : t("naps")} · ${t("today")}`}
          tone={sleepView.state === "sleeping" ? "live" : "normal"}>
          {s?.activeSleep ? (
            <KioskAction label={t("Wake")} primary onClick={() => wakeSleep.mutate({ id: s.activeSleep!.id, endTime: iso() })} />
          ) : (
            <>
              <KioskAction label={t("Sleep")} hint={lastLocation ?? undefined} primary
                onClick={() => startSleep.mutate({ babyId, startTime: iso(), location: lastLocation ?? undefined, type: sleepTypeAt(new Date()) },
                  { onSuccess: (row) => setUndo({ kind: "sleep", id: row.id, text: undoText("sleep") }) })} />
              {otherLocations.map((name) => (
                <KioskAction key={name} label={name}
                  onClick={() => startSleep.mutate({ babyId, startTime: iso(), location: name, type: sleepTypeAt(new Date()) },
                    { onSuccess: (row) => setUndo({ kind: "sleep", id: row.id, text: undoText("sleep") }) })} />
              ))}
            </>
          )}
        </KioskCard>

        <KioskCard testId="kiosk-feed" icon={IconBabyBottle} tint="text-feed" label={t("Feed")}
          headline={feedView.headline} detail={feedView.detail}
          sub={night || !s ? null : `${s.today.feeds} ${t("feeds")} · ${formatVolume(s.today.intakeMl, units)} ${t("today")}`}
          tone={feedView.live ? "live" : feedCaution ? "caution" : "normal"}>
          {s?.activeFeed ? (
            <>
              <KioskAction label={t("Switch")} onClick={() => switchSide.mutate({ id: s.activeFeed!.id, babyId, side: s.activeFeed!.runningSide === "left" ? "right" : "left" })} />
              <KioskAction label={t("Stop")} primary onClick={() => stopTimer.mutate({ id: s.activeFeed!.id, babyId, kind: "breast", time: iso() })} />
            </>
          ) : (
            <>
              <KioskAction label={t("Bottle")} hint={formatVolume(bottle.amountMl, units)} primary
                onClick={() => logFeed.mutate({ babyId, time: iso(), type: "bottle", amountMl: bottle.amountMl, contents: bottle.contents ?? undefined },
                  { onSuccess: (row) => setUndo({ kind: "feed", id: row.id, text: undoText("feed", formatVolume(bottle.amountMl, units)) }) })} />
              <KioskAction label={t("Breast L")} onClick={() => startTimer.mutate({ babyId, kind: "breast", side: "left", startTime: iso() })} />
              <KioskAction label={t("Breast R")} onClick={() => startTimer.mutate({ babyId, kind: "breast", side: "right", startTime: iso() })} />
            </>
          )}
        </KioskCard>

        <KioskCard testId="kiosk-diaper" icon={IconDiaper} tint="text-diaper" label={t("Diaper")}
          headline={s?.lastDiaper ? formatElapsedSafe(new Date(s.lastDiaper.time), now) : "—"}
          detail={s?.lastDiaper ? `${t("ago")} · ${t(s.lastDiaper.type)}` : t("No diaper logged yet")}
          sub={night || !s ? null : `${s.today.wet} ${t("wet")} · ${s.today.dirty} ${t("dirty")} · ${s.today.both} ${t("both")}`}
          tone={diaperCaution ? "caution" : "normal"}>
          {(["wet", "dirty", "both"] as const).map((type) => (
            <KioskAction key={type} label={t(type === "wet" ? "Wet" : type === "dirty" ? "Dirty" : "Both")}
              onClick={() => logDiaper.mutate({ babyId, time: iso(), type },
                { onSuccess: (row) => setUndo({ kind: "diaper", id: row.id, text: undoText("diaper", type) }) })} />
          ))}
        </KioskCard>
      </div>

      {!night && (
        <div className="space-y-3 pt-3.5">
          {medicines.map((m) => (
            <KioskMedicineStrip key={m.id} entry={m} now={now}
              onLog={() => createOther.mutate({ kind: "medicine", babyId, time: iso(), medicineId: m.id, name: m.name, amount: m.defaultAmount ?? undefined, unit: m.unit ?? undefined },
                { onSuccess: (row) => { const id = (row as { id?: string })?.id; if (id) setUndo({ kind: "medicine", id, text: undoText("medicine", m.name) }); } })} />
          ))}
        </div>
      )}

      <p className="fixed right-8 bottom-4 text-[13px] text-muted">{t("Hold the name to leave kiosk")}</p>
      {undo && <KioskUndo text={undo.text} onUndo={doUndo} />}
      <KioskIdleOverlay state={idle} onWake={wake} />
      {pad && <KioskPinPad length={storedPinLength() ?? 4} onSuccess={leave} onCancel={() => setPad(false)} onLockout={lockout} />}
    </div>
  );
}

import { formatElapsed } from "@/lib/time";
function formatElapsedSafe(since: Date, now: Date): string {
  return formatElapsed(since, now);
}
```
  (Move the `formatElapsed` import to the top with the others and drop the wrapper — it is shown separately only to keep the listing readable.)

  New dictionary rows: `live`, `Hold to leave kiosk mode`, `Leave kiosk mode`, `Enter the kiosk PIN`, `PIN`, `Backspace`, `Cancel` (exists?), `Undo`, `last dose`, `Log dose`, `Breast L`, `Breast R`, `Switch`, `Stop`, `No diaper logged yet`, `Hold the name to leave kiosk`, `No baby yet` (exists), `Sleeping` (exists), `Awake` (exists), `wet`/`dirty`/`both` (exist). Run `node scripts/check-i18n.mjs` and add exactly what it lists.

- [ ] **Step 4: Run** — `bun run check` clean, `bun test` PASS (the guard test now walks `components/kiosk`).
- [ ] **Step 5: Commit** — `git commit -m "feat(kiosk): the care station screen — cards with one-tap actions, undo, medicine strip, PIN pad, wake lock, idle dim"`

---

### Task 6: Settings switch

**Files:**
- Create: `apps/frontend/src/screens/settings/KioskSection.tsx`
- Modify: `apps/frontend/src/screens/settings/index.tsx` (render it after `<AppearanceSection />`)

- [ ] **Step 1: Component**

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { PIN_MAX, PIN_MIN, enableKiosk, isValidPin } from "@/lib/kiosk";
import { SectionTitle } from "./lib";

// Settings → Preferences → Kiosk mode (spec §8): the switch and its PIN.
export function KioskSection() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const error = !isValidPin(pin) && pin.length > 0
    ? `${PIN_MIN}–${PIN_MAX} ${t("digits")}`
    : again.length > 0 && again !== pin ? t("PINs do not match") : null;
  const canStart = isValidPin(pin) && again === pin && !busy;
  const start = async () => {
    setBusy(true);
    try {
      await enableKiosk(pin);
      setOpen(false);
      void navigate({ to: "/kiosk" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle>{t("Kiosk mode")}</SectionTitle>
      <Card className="space-y-3">
        <p className="text-sm text-muted">
          {t("Turns this device into the family's care station: a big clock, the last feed, diaper and sleep with one-tap logging, and nothing else. Entries are logged as you. Leaving asks for a PIN.")}
        </p>
        <Button size="full" variant="outline" onClick={() => { setPin(""); setAgain(""); setOpen(true); }}>
          {t("Turn on kiosk mode")}
        </Button>
      </Card>
      <Sheet open={open} onOpenChange={setOpen} title={t("Kiosk mode")}>
        <div className="space-y-4 pb-4">
          <p className="text-sm text-muted">{t("Choose a PIN for leaving kiosk mode on this device.")}</p>
          <Input type="password" inputMode="numeric" autoComplete="off" placeholder={t("PIN")} aria-label={t("PIN")} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))} />
          <Input type="password" inputMode="numeric" autoComplete="off" placeholder={t("Repeat PIN")} aria-label={t("Repeat PIN")} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))} />
          {error && <p className="px-1 text-sm text-danger">{error}</p>}
          <Button size="full" disabled={!canStart} onClick={() => void start()}>{t("Start kiosk")}</Button>
        </div>
      </Sheet>
    </>
  );
}
```
  Dictionary rows: `Kiosk mode`, `digits`, `PINs do not match`, the long paragraph, `Turn on kiosk mode`, `Choose a PIN for leaving kiosk mode on this device.`, `Repeat PIN`, `Start kiosk`.

- [ ] **Step 2: Mount** — in `settings/index.tsx`, `import { KioskSection } from "./KioskSection";` and render `<KioskSection />` directly after `<AppearanceSection />`.
- [ ] **Step 3: Run** — `bun run check` clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(kiosk): Settings switch with a local PIN"`

---

### Task 7: E2E and docs

**Files:**
- Create: `e2e/kiosk.spec.ts`
- Modify: `e2e/playwright.config.ts` (tablet `testMatch: /(layout|kiosk)\.spec\.ts/`)
- Modify: `DECISIONS.md`, `SMOKE-TEST.md`, `CLAUDE.md`

- [ ] **Step 1: The spec**

```ts
import { createHash } from "node:crypto";
import { expect, test } from "./fixtures";
import { freshFamily } from "./helpers";

// Kiosk mode (docs/superpowers/specs/2026-09-08-kiosk-mode-design.md).
// Runs on the mobile and tablet projects. The flag and the PIN hash are
// seeded the way lib/kiosk.ts stores them, so the app boots straight into
// the care station.
const PIN = "2580";
const HASH = createHash("sha256").update(`pjokk-kiosk:${PIN}`).digest("hex");

test.beforeEach(async ({ context }) => {
  await context.addInitScript(({ hash, len }) => {
    try {
      localStorage.setItem("pjokk.kiosk.on", "1");
      localStorage.setItem("pjokk.kiosk.pin", hash);
      localStorage.setItem("pjokk.kiosk.pinlen", String(len));
    } catch {
      // storage unavailable
    }
  }, { hash: HASH, len: PIN.length });
});

test("a kiosk device lands on the care station and logs a diaper with undo", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-diaper");
  await expect(page).toHaveURL(/\/kiosk/);
  await expect(page.getByTestId("kiosk-clock")).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  const diaper = page.getByTestId("kiosk-diaper");
  await diaper.getByRole("button", { name: "Wet" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeVisible();
  await expect(diaper.getByText("under a minute")).toBeVisible({ timeout: 10_000 });
  await expect(diaper.getByText(/^1 wet/)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Wet diaper logged")).toBeHidden();
  await expect(diaper.getByText(/^0 wet/)).toBeVisible({ timeout: 10_000 });
});

test("sleep and wake from the card", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-sleep");
  const card = page.getByTestId("kiosk-sleep");
  await card.getByRole("button", { name: "Sleep" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Wake" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText(/^1 nap/)).toBeVisible();
});

test("nursing timer from the card", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-breast");
  const card = page.getByTestId("kiosk-feed");
  await card.getByRole("button", { name: "Breast L" }).click();
  await expect(card).toHaveAttribute("data-tone", "live", { timeout: 10_000 });
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card).toHaveAttribute("data-tone", "normal", { timeout: 10_000 });
  await expect(card.getByText("under a minute")).toBeVisible();
});

test("/home redirects to /kiosk while the flag is on; the PIN leaves", async ({ page, request }) => {
  await freshFamily(page, request, "kiosk-leave");
  await page.goto("/home");
  await expect(page).toHaveURL(/\/kiosk/);

  const name = page.getByRole("button", { name: "Hold to leave kiosk mode" });
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1700);
  await page.mouse.up();
  const pad = page.getByRole("dialog", { name: "Leave kiosk mode" });
  await expect(pad).toBeVisible();
  for (const d of "1111") await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(pad.getByText("Wrong PIN")).toBeVisible();
  for (const d of PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 10_000 });
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
});

test("night keeps the cards on the amber palette without totals", async ({ page, request, context }) => {
  await context.addInitScript(() => {
    try { localStorage.setItem("pjokk.night.mode", "on"); } catch { /* storage unavailable */ }
  });
  await freshFamily(page, request, "kiosk-night");
  await expect(page.locator("html")).toHaveClass(/kiosk/);
  await expect(page.locator("html")).toHaveClass(/night/);
  await expect(page.getByTestId("kiosk-sleep")).toBeVisible();
  await expect(page.getByText(/feeds · .* ml$/)).toHaveCount(0);
});

test("Settings turns kiosk on with a PIN", async ({ page, request, context }) => {
  await context.addInitScript(() => {
    try { localStorage.removeItem("pjokk.kiosk.on"); localStorage.removeItem("pjokk.kiosk.pin"); localStorage.removeItem("pjokk.kiosk.pinlen"); } catch { /* storage unavailable */ }
  });
  await freshFamily(page, request, "kiosk-settings");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Turn on kiosk mode" }).click();
  await page.getByLabel("PIN", { exact: true }).fill("1234");
  await page.getByLabel("Repeat PIN").fill("1234");
  await page.getByRole("button", { name: "Start kiosk" }).click();
  await expect(page).toHaveURL(/\/kiosk/);
});
```

- [ ] **Step 2: Config** — tablet project `testMatch: /(layout|kiosk)\.spec\.ts/`. The mobile project runs everything already.
- [ ] **Step 3: Docs** — DECISIONS.md section "2026-09-08 — kiosk mode: a care station, not a bigger Home" (own palette; one tap + Undo instead of sheets; elapsed time first, clock second; amber from the reminder interval; local PIN until spec 3; no scenes). SMOKE-TEST.md item 24 under §6 (the manual hour on a tablet). CLAUDE.md Frontend bullet after the responsive-shell one.
- [ ] **Step 4: Run** — `bun run typecheck`; then `E2E_REBUILD=1 bash scripts/e2e-stack.sh up`, `cd e2e && bunx playwright test kiosk.spec.ts` (mobile + tablet), `bunx playwright test --project=mobile`, `bash scripts/e2e-stack.sh down`.
- [ ] **Step 5: Commit** — `git commit -m "test(e2e): kiosk mode spec; docs"`

---

### Task 8: Verification and PR

- [ ] `bun run check && bun run test && (cd apps/frontend && bun run build)`
- [ ] `git push -u origin feat/kiosk-mode` and `gh pr create` titled `feat(kiosk): care station mode for a nursery tablet` with the summary, the canvas link, the test plan, and the standard footer.

## Self-review

- Spec §1 → Task 1 + Task 3 (boot class); §2 → Task 4; §3 → Task 3; §4–§7 → Task 5 (+Task 2 helpers); §8 → Task 6; §9 → Task 5's `md:grid-cols-3` grid; §10 nothing to build; Testing → Tasks 1–5 unit, Task 7 e2e/manual.
- Types: `UndoKind`, `PinPadState`, `IdleState`, `StorageLike` defined before use; `KioskPinPad.length` comes from `storedPinLength()`; `KioskCard.tone` values match `data-tone` the e2e reads.
- Known judgment calls: `verifyPin` returns true with no stored hash (a kiosk enabled by an older build) so a device can always be left; `useCreateOther` returns `unknown`, so the medicine undo id is read defensively.
