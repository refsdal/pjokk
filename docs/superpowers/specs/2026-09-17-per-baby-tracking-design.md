# What to track: per-baby feature switches

The app has grown to thirteen More tiles, five Home banners and a Stats
tab that assumes every family logs everything. The feedback that
prompted this (2026-09-17, from a parent using it daily) was that it has
come to include far too much: a newborn has no barnehage, a fourteen-
month-old has no bottles, and some couples only want sleep and food.

This adds one set of switches per baby. A switch that is off removes the
feature's ENTRY POINTS from every screen — the button, the tile, the
card, the reminder, the stats row — and nothing else: history stays on
the timeline, the server still accepts the writes, and turning the switch
back on brings everything back. New babies start with nothing tracked and
choose from a carousel of cards right after creation, with a recommended
set derived from the birth date. Existing babies keep everything.

Decisions taken with the owner in the brainstorm, 2026-09-17:

- Per baby, not per family, for this round. Contacts, the Calendar tab,
  API keys and Ask for help are family-wide and stay as they are.
- Hide the entry points only (option 1 of three). History of a switched-
  off kind still shows on the timeline under All; the export is untouched.
- Only family admins flip the switches.
- The recommendation is derived from the birth date, never asked.
- The carousel is one card per switch with a live mock of the feature,
  buttons as the primary control, and a "light-up" on enabling.

## The model

One column, no new table:

```sql
ALTER TABLE "baby" ADD COLUMN "features" text[] NOT NULL DEFAULT '{}';
-- Backfill: every baby that exists today keeps everything.
UPDATE "baby" SET "features" = ARRAY[
  'feeds','pump','sleep','diapers','medicine','measurements','milestones',
  'bath','notes','play','daycare','illness','vaccines'
];
```

The array lists the ENABLED keys. A column rather than a `baby_feature`
table because a switch set is a set: it rides with the baby everywhere
the baby is already loaded, it needs no restore classification, no
backup registration and no account-deletion rule, and replacing it whole
is idempotent. New rows default to empty: a baby is created first and
chooses second (see The carousel), so an abandoned carousel leaves a baby
with nothing tracked rather than no baby.

### The thirteen keys

| Key | Covers | Group |
|---|---|---|
| `feeds` | the Feed button and sheet (bottle, breast with the nursing timer, solids), last-feed card, feed reminders, intake stats | Everyday |
| `sleep` | Sleep button and sheet, the sleeping banner, the Awake card and nap-window guide, usual nap, sleep stats and chart | Everyday |
| `diapers` | Diaper button and sheet, last-diaper card, diaper reminders, the diaper count | Everyday |
| `pump` | Pump tile and sheet, the pump timer, pump reminders | Everyday |
| `medicine` | Medicine tile, the kiosk medicine strip, medicine reminders, the barnehage medicine sheet | Health |
| `measurements` | Measurement tile (weight, length, head, temperature), the growth chart, the temperature sparkline | Health |
| `illness` | Illness tile, the illness card, sick-child days, the ill-days stats row | Health |
| `vaccines` | Vaccines tile | Health |
| `daycare` | Barnehage tile, banner, handover card, closed-day line, the place and pick-up plan, the "About <name>" page, the daycare stats card, closing alerts | Barnehage |
| `play` | the three play tiles and the play banner | Extras |
| `milestones` | Milestone tile and photos | Extras |
| `bath` | Bath tile | Extras |
| `notes` | Note tile | Extras |

Two sub-switches floated in the brainstorm were dropped: the nursing
timer is part of the Breast feed type and needs no key, and the nap
guide keeps its per-device switch in Profile and simply follows `sleep`.

The key list lives in ONE place on each side: the `Feature` enum in
`openapi/pjokk.yaml` (which the generated Go and TS types both carry) and
the catalogue in `lib/tracking.ts`, which `packages/shared` checks
against the spec the way the other enums are checked, so a key cannot be
added to one and missed in the other.

## API

- `Baby` gains `features: Feature[]`, required. Every screen already
  holds the babies list, so every screen has the set without a second
  read.
- `PUT /api/babies/{id}/features` with `{ "features": Feature[] }`
  replaces the whole set and answers with the `Baby`. `tierAdmin` (403
  for a member), not in `deviceOperations` (a kiosk answers 403
  `NOT_FOR_DEVICES`), and an unknown key is a 400 from the request
  validator. Whole-set replacement rather than a per-key toggle so a
  replayed offline save is harmless.
- `POST /api/babies` is unchanged.

### What the server does when a key is off

- **Writes are still accepted.** The switch is a preference about the
  UI, not a permission. An API key that posts a feed for a baby with
  `feeds` off succeeds, and so does a queued offline save from before the
  switch was flipped. Refusing would turn "hide" into "gate".
- **Reminders hold.** `internal/jobs/reminders.go` skips a `feed`,
  `diaper`, `pump` or `medicine` reminder whose baby has that kind off,
  the way barnehage holds the since-last kinds today. A reminder with no
  baby applies to each baby that has the kind on. `custom` reminders are
  never held. Holding, not latching: the reminder fires again when the
  switch comes back.
- **Closing alerts** (`jobs.RunDaycareClosingAlerts`) skip a baby whose
  `daycare` is off, even if it is enrolled.
- Export, backup, the timeline query, the summary and the stats queries
  are untouched. Hiding is the client's job, which keeps the server half
  to one column, one route and two job checks.

## The client

### One hook

`useTracking(baby)` in `lib/tracking.ts` returns `has(key)` over the
baby's `features`, and `familyTracks(babies, key)` says whether ANY baby
has it. Every hidden surface reads one of these two. Nothing inspects
the array itself.

### What hides where, for the selected baby

- **Home.** The 2×2 grid becomes "the enabled core buttons, then More",
  and reflows: three core plus More is today's grid; two plus More is a
  row of three; one plus More is a row of two. More stays, since Ask for
  help lives there; the whole grid gives way to the nothing-tracked card
  when the set is empty. The status cards (last feed, last diaper, the Awake /
  Sleeping card), the feed-timer banner, the play banner, the barnehage
  banner, the handover card, the closed-day line, the illness card and
  the today chips each follow their key. Night mode's three actions
  (Wake / Feed / Diaper) follow `sleep`, `feeds` and `diapers`.
- **Nothing tracked.** A baby with an empty set shows, in place of the
  grid, a card: "Choose what to track for Ida" with a button into the
  carousel for an admin, and the quiet line "Nothing is tracked for Ida
  yet" for a member. This is also what a brand-new baby's Home looks
  like if the carousel was abandoned.
- **More sheet and the wide-layout tiles.** `moreActions()` filters by
  key. "Ask for help" always stays. The existing order test still pins
  the order of what remains.
- **Timeline.** History of a switched-off kind still shows under All.
  The filter chips are for the ENABLED kinds only: Feeds, Sleep and
  Diapers follow their keys and Other shows when any More-kind is on.
  (A chip for an off kind that has rows would need a per-kind count the
  API does not return; All already answers it.)
- **Stats.** The sleep cards, the bar chart and Longest stretch need
  `sleep`; Intake needs `feeds`; the diaper count in it needs `diapers`;
  the growth chart needs `measurements`; the barnehage card needs
  `daycare`; the ill-days row needs `illness`. With neither `sleep` nor
  `feeds` on, the tab shows one line, "Turn on Sleep or Feeds to see
  stats", and nothing else.
- **Settings → baby page.** A new first row, "What to track", opens the
  carousel. The usual-nap card follows `sleep`; the "About <name>" and
  medicine-sheet cards follow `daycare`; the PDF report always shows.
- **Settings → Family.** The rows for medicines, sleep locations, the
  barnehage and sick-child days show when ANY baby in the family has the
  kind on. `familySections()` in `lib/settings-nav.ts` gains a `feature`
  field per section and filters by the family's union, so a row cannot
  outlive the last baby that used it.
- **Profile → Reminders.** The kinds offered for a baby follow that
  baby's keys.
- **Kiosk.** The three cards follow `feeds`, `diapers` and `sleep`; the
  medicine strip follows `medicine`. A tablet reads the same babies
  list, so no device route changes.
- **Hotkeys and shortcuts.** F / D / S bind only for enabled kinds. The
  manifest shortcuts are static, so `/home?log=feed` for a baby with
  `feeds` off is stripped from the URL without opening anything.
- **Direct URLs** such as `/vaccines` still open. Hiding an entry point
  is not blocking a link, and a push action may carry one.

Data belongs to a baby, so the set is the SELECTED baby's: switching
babies in the header changes the grid. A family with a newborn and a
barnehage child sees two different Homes, which is the point.

### The carousel

A full-screen page, `/settings/baby/$babyId/tracking`, reached from the
baby page's "What to track" row and from both add-baby flows right after
the POST succeeds (Welcome and the settings BabySheet), with `?new=1`
making Done go to `/home` instead of back.

- One card per key, in the table's order (Everyday, Health, Barnehage,
  Extras), then a summary card listing what is on.
- CSS `scroll-snap` on a horizontal strip, with Back and Next buttons as
  the primary control and a dot strip between them. Swipe works as a
  bonus; the app's no-swipe-navigation rule is about ROUTE navigation
  fighting the back gesture, and the buttons mean nobody has to swipe.
- For a new baby, card one carries "Use the recommended set for a
  3-week-old", which enables the band's set and jumps to the summary.
- Each card: the live mock, the title, a one-line description, the
  toggle (44 px), and the tag "Recommended for Ida's age" when the band
  says so. The barnehage card's tag reads "Recommended if Ida goes to
  barnehage" instead, and is never age-driven.
- Every flip saves at once through an optimistic mutation on the babies
  query, so leaving mid-way keeps what was chosen and a flip made offline
  queues like any log. Done only navigates.
- A member who opens the page sees the cards read-only, with the toggles
  replaced by On / Off text.

#### The recommended set

`recommended(ageMonths)` in `lib/tracking.ts`, pure and unit-tested:

| Age when the carousel opens | Recommended on |
|---|---|
| under 4 months | `feeds`, `sleep`, `diapers`, `measurements` |
| 4 to 12 months | `feeds`, `sleep`, `diapers`, `measurements`, `milestones`, `play` |
| 12 months and up | `sleep`, `diapers`, `medicine`, `illness` |

A Norwegian barnehage child is one year old and stays in diapers until
two or three, so diapers stay recommended; feeds are what stops being
logged. `pump` and `daycare` are never recommended by age: pumping is a
"you know if you need this" feature, and barnehage is a fact, not an
age. `vaccines`, `bath` and `notes` are never recommended either.

#### The mocks

Each card's illustration is built from the app's own pieces, not
artwork: the Feeds card shows a real `StatusCard` reading "Last feed 1 h
20 min ago · 120 ml bottle", the Sleep card the sleeping banner with a
ticking counter, the Barnehage card the banner's "Pick-up 15:30 · Anne"
line, the Measurements card a three-point sparkline, and so on. One small
CSS animation per card, the way the landing hero is done. Thirteen
hand-made animations would be a production cost, double the bundle, and
need a night-mode version each; a mock built from real components reads
in every theme for free and shows exactly what will appear on Home.

#### The light-up

- **Off:** the mock is desaturated and dimmed (`filter: grayscale(1)
  opacity(.45)`), the title muted, the toggle grey. It reads as asleep.
- **Turning on:** the mock returns to full colour and the category tint
  returns to its icon; the mock plays its one animation once; a ring in
  the category tint pulses out from the toggle and fades; the phone
  gives one short tick through `navigator.vibrate(10)` where it exists.
  About 400 ms in total.
- **Turning off** just dims, with no ceremony: switching something off
  should feel like tidying, not losing.
- **Night mode:** the tint and the ring collapse to the amber ramp like
  everything else.
- **Reduced motion:** under `prefers-reduced-motion` the pulse and the
  mock's animation become a plain crossfade; the haptic stays, since it
  is not motion on screen.
- Nothing else moves. One accent, tints on icons and the ring only, no
  confetti. Calm, not cute, but satisfying.

### Code shape

- `lib/tracking.ts`: the `Feature` type (aliased from the generated
  schema), the catalogue (`key`, `label`, `description`, `group`, `tint`,
  `icon`, `recommendedFor`), `recommended(ageMonths)`, `useTracking`,
  `familyTracks`, and `ageMonths(birthDate, now)`.
- `components/tracking/TrackingCarousel.tsx`, `TrackingCard.tsx`, and
  `mocks.tsx` (one small component per key).
- `screens/settings/TrackingPage.tsx` under the baby route.
- `lib/i18n.ts`: Norwegian for every label, description and tag; `bun run
  check` fails on a missing one.

## Testing

- **Go:** the PUT as admin, member (403), kiosk device (403), API key,
  and with an unknown key (400); the backfill migration leaves every
  existing baby with all thirteen; a reminder holds for a baby with the
  kind off and fires once it is on again; the closing alert skips a baby
  with `daycare` off.
- **Frontend unit:** the bands at the boundaries (3 months 30 days, 4
  months, 11 months, 12 months); the grid reflow for four, three, two,
  one and zero enabled; `moreActions()` filtering with the order test
  still green; `familySections()` union across two babies;
  `?log=feed` stripped when `feeds` is off.
- **Playwright:** add a baby, walk the carousel, take the recommended
  set, see Home reflow to the band; from the baby page switch Feeds off
  and see the Feed button, the Feeds chip, the intake card and the feed
  reminder kind go while an old feed row still shows under All; a member
  sees the page read-only; the kiosk hides a card. The tablet and
  desktop projects add one reflow check to `layout.spec.ts`.

## Out of scope, deliberately

- Family-wide switches (Calendar tab, Contacts). Per baby is enough for
  this round; the union rule on the Family page is the only family-level
  consequence.
- Feed-type switches (bottle-only families). `feeds` is one key.
- Hiding history. Option 1 was chosen; the timeline's All shows it.
- Refusing writes for an off kind, on any route.
- Per-device or per-person overrides. The family agrees on one app.
