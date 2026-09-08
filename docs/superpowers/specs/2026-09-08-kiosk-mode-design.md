# Kiosk mode ("care station") — Design

**Date:** 2026-09-08
**Status:** Approved design, pending implementation plan
**Series:** 2 of 3 — after the responsive shell (PR #70), before *device
enrolment + caretaker selector* (a family-scoped device credential with a
Netflix-style attribution row). A Google Cast receiver is a possible spec
4 and depends on spec 3's device credential.

## Problem

A tablet on the changing table or the nursery wall is the most common
"big screen" a family owns, and it is shared, always on, and glanced at
from across the room. The responsive shell makes the app *fit* it; it
does not make it *behave* like a nursery appliance. Today the tablet
shows a signed-in parent's app: a rail, settings, the More sheet, and a
screen that sleeps. Sprout Track, the app Pjokk replaces, has a "Nursery
Mode" for exactly this, and it is one of the two things it does that
Pjokk has no answer to (the other is caretaker PINs — spec 3).

Reviewed on a design canvas (three "Home, larger" directions, then the
"care station" round): the layout that won logs **on the card** with one
tap and an Undo, has its **own palette** so the state is unmistakable,
keeps the **elapsed time** as the headline and the clock second, and adds
the one thing Sprout Track had that Pjokk lacked — a card that turns
amber when the family's own reminder interval has passed.

## Goals

- A per-device switch: the tablet becomes the family's care station and
  stays one across reloads, until someone with the kiosk PIN leaves.
- Glanceable from two metres, loggable at arm's length, both equally.
- One tap logs. No sheet, no rail, no More, no settings reachable.
- Its own dark palette by day; the amber night ramp on the schedule.
- The screen never sleeps while kiosk is on; it dims after idle.
- Everything the kiosk shows and does already exists in the API. This
  spec adds **no server change**: no migration, no endpoint, no OpenAPI
  edit.

## Non-goals

- Device credentials, caretaker selection, attribution on a shared
  tablet — spec 3. In this spec the kiosk logs as the signed-in user, and
  Settings says so when kiosk is switched on.
- Scenes, sprites, photos, hue sliders, a settings drawer. One palette.
- Recent list, room sensors, weather, a photo frame.
- Casting to a Nest Hub (spec 4).
- Solids, pump, medicine beyond "log the default dose", play, help, notes.
  Anything the three cards and the medicine strip do not cover is done
  from a phone.

## Design

### 1. Device state (`lib/kiosk.ts`)

Per-device, in localStorage, like night mode and the nap guide:

| Key                | Value                                         |
|--------------------|-----------------------------------------------|
| `pjokk.kiosk.on`   | `"1"` while kiosk is on, absent otherwise      |
| `pjokk.kiosk.pin`  | SHA-256 hex of the PIN, `"pjokk-kiosk:" + pin` |

A tiny external store (the `selected-baby.ts` pattern) exposes
`useKiosk(): { on: boolean }`, `enableKiosk(pin)`, `disableKiosk()`, and
pure `hashPin(pin): Promise<string>` / `verifyPin(pin, hash)`. The PIN is
4–6 digits. Hashing uses `crypto.subtle` (available on the app's HTTPS
origins and on localhost); the hash is a *convenience lock* against
toddlers and guests, not a security boundary — the tablet already holds
a full session cookie, and spec 3 replaces it with a device credential.

The boot script `public/theme-init.js` toggles a `kiosk` class on `<html>`
from `pjokk.kiosk.on` before first paint, as it does for `dark` and
`night`, so a reload never flashes the app palette.

### 2. Routing and the shell

- New route **`/kiosk`**, parented at `rootRoute` (a sibling of the
  authed shell, like `/admin`), rendering `KioskScreen`. It needs the same
  guards as the shell — session, family, the family fence — so those move
  out of `AppShell` into an **`AuthGate`** component in
  `screens/shell.tsx` that both shells render around their content.
  `AppShell` = `AuthGate` + impersonation banner + rail offset + `Outlet` +
  `TabBar`. `/kiosk` = `AuthGate` + `KioskScreen`. No tab bar, no rail, no
  1400 px cap, no InstallBanner, no UpdateBanner interaction beyond what
  the root already mounts.
- **While kiosk is on, the device is the kiosk.** `AppShell` redirects
  every app route to `/kiosk` (`Navigate`), so a reload, a manifest
  shortcut or a push-action URL all land on the care station. `/login`,
  `/join/*`, `/welcome` and `/admin` are untouched: a signed-out kiosk
  shows the login screen and returns to `/kiosk` after sign-in because
  the flag is still set.
- **Leaving:** a 1.5 s press-and-hold on the baby's name opens the PIN
  pad (§6). A correct PIN calls `disableKiosk()` and navigates to
  `/home`. Three wrong PINs in a row disable the pad for 30 s.
- If kiosk is on but the family has no baby, the screen shows the same
  "No baby yet" state as Home with a Leave button that asks for the PIN.

### 3. Palette

A fourth palette block in `styles.css`, `.kiosk`, declared **before**
`.night` so night still wins at 22:00. Cool, dark, one mint accent —
deliberately a different hue from the warm dark mode and from the amber
night ramp. Category tints are the dark-mode ones. Solid surfaces (no
glass), because `contrast.test.ts` checks hex tokens and the app's rule
is tints on icons only.

```
.kiosk {
  --color-bg: #131a21;   --color-surface: #1b242d;  --color-surface-2: #253039;
  --color-ink: #e8eef2;  --color-ink-soft: #b7c3cc; --color-muted: #8a98a3;
  --color-line: #2b3640; --color-accent: #7fd6b5;   --color-accent-soft: #1d3a31;
  --color-on-accent: #0f1a17; --color-danger: #e08a7e;
  --color-ok: #6fcf97;   --color-caution: #e0a94a;
  --color-sleep: #a294e6; --color-feed: #7fb3e8; --color-diaper: #56c6b9; --color-growth: #efa07e;
}
```

`contrast.test.ts` gains `kiosk` as a fourth theme; every token above
must clear the same floors the other three do (4.5:1 text, 3:1 graphics).
`lib/system-chrome.ts` reports the kiosk background as the status-bar
colour while the class is on (it is dark, so the installed-app rule is
satisfied).

### 4. The screen (`screens/Kiosk.tsx` + `components/kiosk/*`)

Landscape tablet is the target; the layout is a plain CSS grid that
stacks to one column below `md`, so a phone in a stand gets the same
screen scrolled. All text is at least 15 px; every target at least 56 px.

**Band** (`KioskBand`): baby name (26 px, the press-and-hold target) and
"weekday date · age" on the left; the clock in the middle at 72 px, light
weight, tabular; today's totals on the right in two lines ("6 feeds ·
640 ml" / "5 diapers · 2 h 05 m sleep"), from `summary.today`. Under the
band, centred, the nap-window line in the accent colour while
`napWindow()` has something to say — the same text `describeNapWindow`
gives Home. Hidden at night, as is the totals column.

**Three cards** (`KioskCard`, one component, three configurations), each
with an icon disc, an uppercase label, the **elapsed time at 48 px** as
the headline (`formatElapsed`, ticking every 30 s), a detail line, a
totals sub-line (hidden at night), and a row of **quick actions** (56 px
pills, `KioskAction`):

| Card   | Headline                     | Detail                          | Actions                                                                 |
|--------|------------------------------|---------------------------------|-------------------------------------------------------------------------|
| Sleep  | awake for `lastSleep.endTime` ago; or, while `activeSleep`: sleeping for `startTime` ago, LIVE badge, headline in accent | "after a 45 m nap · crib" / "since 13:35 · crib" | Awake: **Sleep** (primary, subtitle = last location) + up to two more of the family's sleep locations; Sleeping: **Wake** only |
| Feed   | `lastFeed.time` ago; or, while `activeFeed`: the running nursing timer's total (`totalSeconds`, ticking every second) with the running side | "ago · 120 ml formula" / "left side · 12:40 since 13:05" | **Bottle** (primary, subtitle = last bottle amount in the user's units), **Breast L**, **Breast R**; while nursing: **Switch**, **Stop** |
| Diaper | `lastDiaper.time` ago         | "ago · wet" (the type)          | **Wet**, **Dirty**, **Both**                                            |

What each action does, all through the existing offline-resumable
mutations, `time` = now:

- Bottle → `useLogFeed` `{type:"bottle", amountMl: last bottle amount or 120, contents: last contents}`.
- Breast L / R → `useStartFeedTimer` `{kind:"breast", side}`; Switch →
  `useSetFeedTimerSide` to the other side; Stop → `useStopFeedTimer`
  (the server banks the seconds into a feed log).
- Sleep <location> → `useStartSleep` `{location, type: sleepTypeAt(now)}`;
  Wake → `useWakeSleep`.
- Wet / Dirty / Both → `useLogDiaper`.
- Log dose (§5) → `useCreateOther` `{kind:"medicine", medicineId, name, amount: defaultAmount, unit}`.

**Caution tone.** A card turns amber (border, headline, disc) when the
signed-in user has a `since_last` reminder of that kind (`useReminders`,
feed or diaper, `intervalMin`) and the elapsed time exceeds it. Pure
function `cautionFor(kind, lastAt, reminders, now)`, unit-tested. No new
setting: the family's own reminder interval is the threshold, exactly as
the push nudge uses it. No reminder, no amber.

**Undo** (`KioskUndo`): every instant action (Bottle, Wet/Dirty/Both, Log
dose, Sleep start) shows a pill toast at the bottom — "Wet diaper
logged · Undo" — for 6 s. Undo calls the matching delete mutation
(`useDeleteFeed` / `useDeleteDiaper` / `useDeleteSleep` /
`useDeleteOther`) with the id the create returned. An action taken while
the previous toast is still up replaces it (the earlier entry stays).
Timers (Breast, Wake, Stop) are not undoable: a mis-tap is corrected by
tapping again. The kiosk uses its own toast, not `lib/toast.ts`, because
it needs a button and a longer life; error toasts from the mutation
defaults still surface through the root `Toaster`.

**Medicine strip** (§5) below the cards; nothing else. No More, no
temperature card, no play, no help.

### 5. Medicine strip

Shown when the family's catalogue (`useMedicineCatalogue`) has an
un-archived entry whose `nextDoseFrom()` is in the future **or** whose
last dose was within the last 24 h: "**Paracetamol** · last dose 11:40 ·
2.5 ml · OK from 15:40" with a **Log dose** button (44 px). Several
qualifying entries stack. "OK from" is in the accent colour while it is
ahead and becomes "OK now" once passed. Log dose is never blocked (the
parent is the authority, as everywhere in the app); it logs
`defaultAmount`, or opens nothing and does nothing if the entry has no
default — such an entry simply shows no button. Hidden at night.

### 6. Leaving: the PIN pad (`KioskPinPad`)

A centred 360 px panel over a 55 % scrim: lock icon, "Leave kiosk mode",
"Enter the kiosk PIN", four to six dots, a 3×4 keypad of 72 px round
keys, backspace, Cancel. Digits fill dots; on the length of the stored
PIN the hash is compared. Wrong: the dots shake and clear, "Wrong PIN".
Third wrong in a row: the pad closes and the name ignores presses for
30 s. Right: `disableKiosk()`, `document.documentElement.classList`
loses `kiosk`, navigate to `/home`.

### 7. Screen behaviour (`lib/kiosk-screen.ts`)

- **Wake lock:** `navigator.wakeLock.request("screen")` on mount and again
  on every `visibilitychange` to visible (the lock is released when the
  tab is hidden). Absent API (older iPad Safari): nothing, no error.
- **Idle dim:** after 120 s without `pointerdown` / `keydown`, a
  full-screen overlay at 60 % black fades in over 1 s. The first tap on
  the overlay clears it and is **swallowed** — it must not also press
  whatever was underneath. The clock keeps ticking beneath; the numbers
  stay legible through the scrim on purpose.
- **Night** is the existing schedule: `.night` overrides `.kiosk`, the
  band drops totals and the nap line, the cards drop their sub-lines, the
  medicine strip is hidden. The layout does not change.
- No fullscreen API call: the installed PWA is already chromeless, and a
  browser tab's fullscreen would need a gesture on every visit.

### 8. Settings

Settings → Preferences gains a **Kiosk mode** section (`KioskSection`,
next to Night mode): a one-paragraph explanation ("Turns this device
into the family's care station: a big clock, the last feed, diaper and
sleep with one-tap logging, no other screens. Entries are logged as
*you* until the caretaker selector ships. Leaving asks for a PIN.") and
a **Turn on kiosk mode** button that opens a sheet: enter a 4–6 digit
PIN, enter it again, **Start kiosk**. Mismatch or too short: inline
message, no save. Start → `enableKiosk(pin)` → navigate `/kiosk`.

### 9. Tiers and orientation

The kiosk layout is its own grid and ignores the shell's tiers: three
columns from `md` up, one column below. Portrait tablet gets one column
with cards full-width; the band wraps to two rows. Nothing else in the
responsive shell applies here (no rail, no side panel, no hotkeys — the
kiosk has no sheets to open).

### 10. What is deliberately NOT here

- Any per-kiosk configuration beyond the PIN. No brightness slider in
  v1; the idle dim is fixed at 60 %.
- A server-side "this device is a kiosk" flag. That is spec 3's device
  row; until then the switch is device-local like night mode.
- The warm-palette alternative from the canvas. Slate was chosen; the
  warm variant is documented on the canvas if the choice is revisited.

## Testing

**Unit (`bun test apps/frontend`)**

- `lib/kiosk.ts`: `hashPin` is deterministic and prefixed; `verifyPin`
  accepts the right PIN and rejects a wrong one and a wrong length;
  `enableKiosk`/`disableKiosk` round-trip through a fake storage.
- `cautionFor`: no reminder → none; feed reminder 180 min, elapsed 179 →
  none; 181 → caution; a diaper reminder never colours the feed card; an
  `at_time` reminder is ignored.
- Kiosk copy helpers (pure): the band's totals lines, the sleep card's
  detail for awake vs sleeping, the medicine strip's "OK from HH:MM" vs
  "OK now", the undo toast text per action.
- `contrast.test.ts`: the `kiosk` block passes the same floors.
- `theme-init.test.ts`: `pjokk.kiosk.on` = "1" adds the `kiosk` class;
  kiosk + night yields both classes.
- `layout-guards.test.ts`: `screens/Kiosk.tsx` and `components/kiosk/*`
  never import `Sheet`, `TabBar`, `HomeActions` or `useHotkeys`.

**E2E (`e2e/kiosk.spec.ts`, tablet project + mobile project)**

1. Seed `pjokk.kiosk.on` + a known PIN hash via `addInitScript`, sign in,
   create a family: the app lands on `/kiosk`; the band shows the baby's
   name and a clock; no navigation landmark is present.
2. Tap **Wet**: the Diaper headline becomes "under a minute", the totals
   line shows 1 wet, the undo toast is visible; tap **Undo**: the toast
   goes, totals return to 0.
3. Tap **Sleep**: the card shows LIVE and **Wake**; tap **Wake**: back to
   Awake with a nap in the totals.
4. Tap **Breast L**: the Feed card shows a running clock and **Stop**; tap
   **Stop**: the headline reads "under a minute".
5. `/home` while kiosk is on redirects to `/kiosk`.
6. Press-and-hold the name for 1.6 s: the PIN pad appears; a wrong PIN
   shows "Wrong PIN"; the right PIN lands on `/home` with the tab bar or
   rail visible again, and `/kiosk` now redirects nowhere (renders
   normally, since the page itself is fine; the flag is simply off).
7. Night: seed `pjokk.night.mode` = "on" too: the `<html>` carries both
   classes, the totals column is hidden, the three cards are present.
8. Settings → Kiosk mode: enter 1234 twice, Start kiosk → `/kiosk`.

**Manual** (SMOKE-TEST.md gains a line under item 23): leave a tablet on
kiosk for an hour: the screen stays on, dims after two minutes, wakes on
tap without logging anything, and turns amber at 22:00.
