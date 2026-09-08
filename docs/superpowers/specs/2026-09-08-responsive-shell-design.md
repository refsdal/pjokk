# Responsive shell (mobile · tablet · desktop) — Design

**Date:** 2026-09-08
**Status:** Approved design, pending implementation plan
**Series:** 1 of 3 — followed by *kiosk mode* (a per-device switch on top
of this layout) and *device enrolment + caretaker selector* (a
family-scoped device credential with Netflix-style attribution). Each is
its own spec.

## Problem

Pjokk is mobile-first and has never been anything else. Every screen and
the tab bar are a centred `max-w-md` column; there is not one responsive
breakpoint in the SPA. On a 10-inch tablet the app is a 448 px strip with
empty margins either side, and the vaul bottom sheets — which have no max
width at all — stretch their chips, steppers and Save button across the
whole viewport, putting Save far from the hand. The installed PWA is also
locked to portrait (`orientation: "portrait"` in the manifest), so a tablet
in a landscape stand cannot rotate it at all.

The kiosk/nursery-tablet mode on the Phase 7 backlog needs a layout that
uses the width before it can add anything on top. Once the shell is
responsive, a desktop layout is mostly free, so this spec designs for
three tiers from the start rather than retrofitting a third later.

## Goals

- The same screens feel native on a phone, a tablet in either orientation,
  and a laptop or desktop browser window — without a second app or a
  "desktop version".
- Logging stays a five-second, touch-first transaction at every size. The
  desktop tier adds keyboard affordances; it never adds density, hover
  menus or smaller targets.
- Every product principle in CLAUDE.md survives unchanged: status before
  action, last-value prefill, night mode's three actions in the bottom
  half, tints on icons only.
- One codebase path: the tier is a CSS/`matchMedia` concern. No component
  is forked into a mobile and a desktop variant.

## Non-goals

- Kiosk mode, idle dimming, wake lock, exit gestures — next spec.
- Device sessions, the caretaker selector, any auth change — spec three.
- Master–detail navigation (a list on the left with the item on the
  right), hover states, right-click menus, resizable panes, multi-window.
- Changing what any screen *shows*. This spec moves things; it does not
  add data or features beyond the one Home "Recent" pane below.
- The public landing site (`apps/landing`) is already responsive and is
  untouched.

## Design

### 1. Tiers

Three tiers, decided by viewport width only — never by user-agent, touch
capability or pointer type. A phone in landscape, a narrowed desktop
window and a tablet all behave predictably.

| Tier      | Width            | Tailwind | What changes                                                          |
|-----------|------------------|----------|-----------------------------------------------------------------------|
| compact   | < 768 px         | (base)   | Nothing. Exactly today's app.                                         |
| regular   | 768 – 1279 px    | `md:`    | Left rail replaces the tab bar; sheets become a right side panel; Home is two panes. |
| wide      | ≥ 1280 px        | `xl:`    | Regular, plus a third Home pane ("Recent") and wider reading columns. |

Tailwind v4's default `md` (768) and `xl` (1280) are the boundaries; no
custom breakpoint tokens. Content is capped at **1400 px** and centred on
anything wider, so a 27-inch monitor does not stretch the layout.

`lib/layout.ts` exposes the tier to the few places that need it in JS:

```ts
export type Tier = "compact" | "regular" | "wide";
export function tierFor(width: number): Tier;   // pure, unit-tested
export function useTier(): Tier;                // matchMedia listeners on 768 and 1280
```

Everything that CAN be expressed as `md:` / `xl:` classes is. `useTier`
exists for the three things that cannot: the vaul drawer `direction` prop,
gating the wide-only "Recent" query so a phone never fetches it, and the
sheet's latched direction (§3).

### 2. Navigation: tab bar → rail

`components/TabBar.tsx` stays ONE component. At compact it is the fixed
bottom bar it is today. At `md:` and up the same `<nav>` becomes a fixed
**left rail**: 88 px wide, full height, the same five icon-over-label
items stacked vertically from the top, same active tint. Pure CSS
(`md:inset-x-auto md:top-0 md:left-0 md:w-22 md:flex-col md:border-t-0
md:border-r`), no second markup path. The admin shell passes its own tab
list and gets the rail for free.

The rail carries navigation only — no logo, no baby switcher, no account
avatar. Those stay in the screen headers where they are today.

Content offset lives in exactly two utility classes in `styles.css`, so
the 22 existing `pb-tabbar` / `pt-safe` call sites are untouched:

- `.pb-tabbar` gains `@media (min-width: 768px) { padding-bottom: 1.5rem }`
  — there is no bottom bar to clear any more.
- `AppShell` (and `AdminShell`) wrap `<Outlet />` in a container with
  `md:pl-22` and the 1400 px cap. Nothing else changes.

### 3. Sheets: bottom drawer → side panel

`components/Sheet.tsx` is the only file that imports vaul, so this is one
change for all seventeen sheets. At compact: unchanged. At regular and
wide: `direction="right"`, a fixed panel on the **right edge**, full
height, **420 px** wide (a phone's width — the sheets were designed for
`max-w-md` minus padding and keep their layout pixel for pixel),
`rounded-l-3xl`, the same 40 % scrim. Save stays a full-width button at
the bottom of a hand-sized column; the content area scrolls.

Two small additions at `md:` and up: the drag handle is hidden (there is
nothing to swipe down), and the title row gains a 44 px close button,
because a side panel has no swipe-to-dismiss cue. Escape already closes it
(vaul is a Radix dialog) and so does the scrim.

**Latched direction.** Changing `direction` on an open vaul drawer re-animates it and may remount its content. A window
resized across 768 px while a feed sheet is half filled
in must not lose what was typed — the same hazard Home already guards for
the 22:00 night flip. The sheet therefore reads the tier **when it
opens** and keeps that direction until it closes; the next open uses the
new tier. A resize mid-edit leaves a bottom sheet on a wide window for a
moment, which is correct and harmless.

### 4. Home

The one screen whose *layout* changes, not just its width. The rule for
regular and wide is **left informs, right acts**: the status column is
on the left, the log buttons are on the right edge — the same edge the
side panel opens from — so while a sheet is open the status cards stay
visible beside it. You can read "last feed 120 ml, 2 h 10 m ago" while
filling in the next one.

- **compact:** today's single column, untouched.
- **regular:** two panes, `md:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]`.
  Left: baby header (switcher + account avatar), help card, active-session
  banners, status cards. Right: the 2×2 log grid, sticky at the top of its
  column, buttons grown from `h-28` to `h-36` with the icon disc and label
  scaled to match. Big screens get bigger targets, not more of them.
- **wide:** three panes, `xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_420px]`:
  status · **Recent** · actions. Recent is the first page of the selected
  baby's timeline (the merged `/api/timeline` query, no filter, no search)
  in the same day-grouped dense rows as the Timeline tab, with tap-to-edit
  through the same sheets. It answers "what has happened today" without
  leaving Home, which on a desktop is the whole point of the third
  column. Its query is `enabled` only at the wide tier.

To share rows and edit dispatch, the Timeline screen's list rendering
(day groups, `Row`, the edit-sheet switch and its sheet state) is
extracted into `components/TimelineList.tsx`, which both the Timeline tab
and the Recent pane render. Timeline keeps its header, search field, chips
and Load more; the list component takes `entries` and owns the edit
sheets. No behaviour change on the phone.

**Night home** keeps its rule of three actions in the bottom half. At
regular and wide the column stays `max-w-md` and is anchored to the
**bottom-right** (`md:items-end`), matching "right acts" and the panel's
edge, rather than stretching three 1200 px buttons across a tablet. The
rail remains, as the tab bar does in night mode today.

### 5. Other screens

Width only; no layout change.

| Screen                     | compact    | regular / wide                                     |
|----------------------------|------------|----------------------------------------------------|
| Timeline                   | `max-w-md` | `md:max-w-2xl` — rows widen, the note column stops truncating so early |
| Stats                      | `max-w-md` | `md:max-w-3xl` — the sleep bar chart and the growth chart get real width; the summary rows sit in a `md:grid-cols-2` |
| Calendar                   | `max-w-md` | `md:max-w-3xl` — the month grid cells become tall enough to show event titles, not just dots |
| Settings, Profile, Vaccines| `max-w-md` | `md:max-w-lg` — iOS-style grouped rows should stay a narrow, scannable list |
| Admin                      | `max-w-xl` | `md:max-w-3xl` |
| Login, Welcome, Join, Error| unchanged  | unchanged — a centred column is already right at any size |

### 6. Keyboard (desktop tier's only addition)

Hotkeys are the one thing a desktop has that a tablet does not, and they
cost nothing on touch devices, so they are not tier-gated:

- On Home, with no sheet open and no input focused: **F** opens Feed,
  **D** Diaper, **S** Sleep (or Wake when a session is running — same as
  the button). Plain keys, no modifier, ignored when `event.target` is an
  input, textarea, select or contenteditable, and ignored with any
  modifier held so browser shortcuts are untouched.
- **Escape** closes the open sheet (already true via vaul; kept and
  tested, not built).
- Visible focus rings on rail items, log buttons, chips and steppers via
  `focus-visible:` classes — today a few interactive elements have
  `outline-none` and nothing in its place.

One hook, `lib/hotkeys.ts` (`useHotkeys(map)`), mounted by Home only. No
global shortcut layer, no shortcut for tabs, no "?" cheat sheet.

### 7. Manifest

`orientation: "portrait"` → `"any"`. A tablet in a stand rotates. Phones
already follow their own rotation lock. Note (from the manifest comments)
that an already-installed Android app only picks this up when Chrome
regenerates the WebAPK, so a reinstall is the way to see it on a device
that has the old one.

### 8. What is deliberately NOT responsive

- Log sheets' internals: chips, steppers, time chips, Save. They are the
  product's core ergonomics and they fit the 420 px panel exactly.
- Touch target sizes never shrink at any tier.
- Night mode's palette and its three-action rule.
- The tab order and information architecture: five tabs, two sheets.

## Testing

**Unit (`bun test apps/frontend`)**

- `tierFor` boundaries: 767 → compact, 768 → regular, 1279 → regular,
  1280 → wide.
- `useHotkeys`: fires on plain `f`; ignores `f` with a modifier, in an
  input, in a textarea, in a contenteditable; ignores unknown keys.
- A file-reading guard in the style of `contrast.test.ts`: `Sheet.tsx` is
  the only file under `src/` that imports `vaul` (so the side-panel logic
  cannot be bypassed by a second drawer), and `TabBar.tsx` contains no
  `useTier` (the rail is CSS-only by design).

**E2E (`e2e/`, Playwright against the real binary)**

Two new Playwright **projects** alongside the Pixel 7 default, each
restricted with `testMatch` to the new `layout.spec.ts` so the existing
specs keep their single mobile run and their timings:

- `tablet`: `devices["Galaxy Tab S4 landscape"]` (Chromium, 1138 × 712 —
  the regular tier).
- `desktop`: `devices["Desktop Chrome"]` at 1440 × 900 (the wide tier).

`layout.spec.ts` (imports from `./fixtures`, day mode):

1. Rail visible and tab bar absent at tablet and desktop; the reverse on
   Pixel 7.
2. Opening Feed at tablet shows a panel anchored to the right edge whose
   width is 420 px; Save is inside the viewport without scrolling.
3. Desktop Home shows three panes and the Recent pane lists the feed just
   logged; tapping it opens the edit sheet.
4. **Resize survival:** open Feed at desktop, step the amount, resize the
   viewport to 600 px wide, assert the stepped value is still there and
   the sheet is still open; close it, reopen, assert it is now a bottom
   sheet.
5. Press `f` on Home → Feed sheet opens; press `f` while the notes field
   is focused → nothing happens; Escape closes the sheet.
6. Night mode at tablet: the three actions are within the bottom half and
   within the right 448 px of the viewport.

**Manual** (SMOKE-TEST.md gains a "Tablet & desktop" section): install on
an Android tablet, rotate, confirm the WebAPK follows; check the iPad
Safari PWA, whose `100dvh` and safe-area handling differ from Chromium.

## Decisions recorded (for DECISIONS.md)

- Tiers by viewport width, never user-agent.
- Bottom sheet → 420 px right panel at `md:`, one component, direction
  latched at open.
- "Left informs, right acts" for Home at regular and wide.
- Hotkeys are plain single keys on Home only, not tier-gated.
- No density, hover or master–detail on desktop: the desktop tier is the
  tablet tier plus a keyboard.
