# What's new, and a first run — Design

**Date:** 2026-09-20
**Issue:** #140
**Status:** Approved design, pending implementation plan

## Problem

Two gaps that look like one feature.

A **returning** caretaker has no way to learn that anything changed. The
barnehage series, illness episodes, care days, the About-me PDF, calendar
recurrence, the nap guide — all of it landed silently. The app grew a great
deal in a month and nobody was told.

A **new** caretaker who arrives by invite — the partner, a grandparent, the
one who scanned a QR code at Sunday dinner — lands on `/home` cold. A
founder at least passes through the per-baby tracking carousel
(`/settings/baby/$babyId/tracking?new=1`); an invitee gets nothing at all.

### The standing rule, and where it bends

`CLAUDE.md`'s information architecture says, flatly:

> No FAB, no swipe navigation (fights PWA back-gesture), no onboarding
> tutorials (the invite flow IS onboarding).

That rule was written when the app was feeds, diapers and sleep, and it was
earned: the home screen is a 2×2 grid of large labelled buttons, and the
common case is a glance, not a lesson. It is kept here for the returning
case, absolutely — **a returning caretaker is never shown anything modal.**

It is deliberately relaxed for genuine first run, for one reason: someone
setting the app up for the first time is not the person logging a bottle at
03:00 in the dark. The cost a tutorial imposes is a function of when it
appears, and first run is the one moment when it is close to zero. The app
already accepts this, in the shape of the full-screen tracking carousel a
founder is sent to the moment a baby is created.

So the invariant is not "never interrupt". It is:

> **A caretaker who has already onboarded is never interrupted.** Everything
> for a returning person is one dismissible hairline row, and the log grid
> never moves and never waits.

## What it is

**One seen-marker, two content sources, two presentations** — each matched
to its content and to how stressed the reader is likely to be.

| | Returning | First run |
|---|---|---|
| Content | Release entries newer than your marker | A short curated getting-started set |
| Presentation | Hairline row at the foot of Home → a list | Full-screen paced carousel |
| Interrupts? | Never | Once, ever, with a visible Skip |
| Gated on | `whats_new_seq` | `onboarded_at IS NULL` |

Why a list for releases and a carousel for first run: three new things are
three cards read in one glance, and making someone swipe through them is
friction applied to precisely the person we are protecting. Orientation, by
contrast, genuinely benefits from being paced one idea at a time.

### Two decisions that keep this from rotting

Most in-app what's-new channels die the same two deaths, so both are
designed against explicitly:

1. **No backlog.** The first entry ever written is the one announcing this
   feature. Entries are not back-written for things that shipped before the
   mechanism existed. Without this, C's first run is a wall of forty cards —
   the tutorial the IA rule bans — and every existing account gets it at
   once.
2. **Relevance gating.** An entry may name a `Feature` key; if that key is
   off for every baby in the family, the entry is skipped silently.
   Announcing the barnehage handover to a family that does not use barnehage
   is noise, and noise is what teaches people to ignore the channel. After
   that it is worse than nothing.

## Design

### 1. Data — migration `00034_user_whats_new.sql`

Two columns on `users`, because they answer two different questions:

```sql
-- +goose Up
alter table "users" add column onboarded_at  timestamptz;
alter table "users" add column whats_new_seq integer not null default 0;

-- Every account that exists today has been using the app for weeks: mark
-- it onboarded so nobody is handed a getting-started tour retroactively.
update "users" set onboarded_at = created_at;

-- +goose Down
alter table "users" drop column whats_new_seq;
alter table "users" drop column onboarded_at;
```

`whats_new_seq` needs no backfill, and that is not an oversight: `default 0`
is correct precisely *because* there is no backlog. An existing account has
seen nothing, but there is nothing to have seen — the lowest entry is the
one announcing this feature, which is genuinely new to them.

`onboarded_at` is stored as a timestamp rather than a boolean because the
date is free to keep and occasionally answers a support question ("when did
this person first set the app up"). It is **not** exposed on the wire.

This adds columns to an existing table, not a new table. None of the
new-table obligations apply: no account-deletion registration, no
`jobs.DeliberatelyExcluded` entry, no `internal/restore` classification
rule. `users` already carries all of them. Stated here so nobody goes
hunting.

### 2. API — no new endpoints

`Me` gains two required fields; `UpdateMe` gains the same two as optional.
Both ride the existing `getMe` / `updateMe` pair in
`apps/server/internal/api/me.go` and `useUpdateMe` in
`apps/frontend/src/lib/data/profile.ts`.

```yaml
Me:
  onboarded:    { type: boolean }
  whatsNewSeq:  { type: integer, minimum: 0 }

UpdateMe:
  onboarded:    { type: boolean }
  whatsNewSeq:  { type: integer, minimum: 0, maximum: 100000 }
```

`onboarded` is a boolean on the wire, not the timestamp. The client has no
use for the date, and a nullable `timestamptz` is a shape we would spend the
next year explaining. The server maps `onboarded: true` → `now()`, `false` →
`NULL`.

**The one guard that matters.** The seq write is:

```sql
whats_new_seq = GREATEST(whats_new_seq, coalesce(sqlc.narg(whats_new_seq), whats_new_seq))
```

Mutations in this app queue while offline and replay later. Without
`GREATEST`, a dismissal made on Tuesday and replayed on Thursday walks the
marker backwards and re-shows entries the person already dismissed —
a nag caused by the very mechanism meant to stop nagging. This is also why
`seq` is an integer and not a version string: comparing `v0.47.0` to
`v0.9.0` needs real semver ordering, and that is a classic place to ship a
bug for no benefit.

`whats_new_seq` follows the existing `COALESCE(sqlc.narg(...), col)` pattern
in `UpdateUserProfile` so a PATCH that omits it leaves it alone.

`onboarded` cannot use that pattern, because it has three states on the wire
(absent, `true`, `false`) mapping to three outcomes (leave alone, `now()`,
`NULL`) and `COALESCE` collapses two of them. It needs an explicit `CASE`:

```sql
onboarded_at = CASE
  WHEN sqlc.narg(onboarded)::bool IS NULL THEN onboarded_at
  WHEN sqlc.narg(onboarded)::bool         THEN coalesce(onboarded_at, now())
  ELSE NULL
END
```

`coalesce(onboarded_at, now())` rather than a bare `now()` so that re-running
the tour from Settings does not rewrite the date on which this person
actually first set the app up.

On the Go side this is the raw-body tri-state already solved in
`apps/server/internal/api/patch.go`; `patchField` is currently used for
`string` and needs a `bool` instantiation.

### 3. Content — `apps/frontend/src/data/whats-new.ts`

Bundled in the SPA. The entry is written in the same PR as the feature it
describes, which means an entry physically cannot describe something the
build does not contain, and `bun run check` fails until the Norwegian exists
in the `nb` dictionary.

```ts
export type WhatsNewEntry = {
  /**
   * Monotonic. APPEND ONLY — never reorder, never reuse. A person's marker
   * is "the highest seq I have seen"; changing what a number means
   * re-shows or silently hides entries for everyone sitting on it.
   */
  seq: number;
  version: string;        // display text only: "v0.48.0"
  title: string;          // written inside t()
  body: string;           // written inside t()
  feature?: Feature;      // relevance gate; omitted = always shown
  icon: TablerIcon;
  tint: string;           // existing category token
};
```

The getting-started set is the same shape minus `seq` and `version`,
exported separately from the same file.

The first entry, shipping with this PR, announces the mechanism itself.

### 4. Selection — `apps/frontend/src/lib/whats-new.ts`

All the logic worth testing, pure, with no React around it:

```ts
export function pending(
  entries: WhatsNewEntry[],
  seq: number,
  enabled: Set<Feature>,
): WhatsNewEntry[];
```

Returns entries with `entry.seq > seq`, dropping any whose `feature` is not
in `enabled`, newest first. `enabled` is the union of `baby.features` across
the family's babies — the same union `familySections` already computes for
the Settings rows, reused rather than reinvented.

`highestSeq(entries)` returns the marker to write on dismissal, and is
computed over the **unfiltered** list. A family that does not use barnehage
still counts the barnehage entry as seen; otherwise switching the feature on
six months later would replay a stale announcement as though it were news.

A family with no babies yet has an empty union, so every feature-tagged
entry is filtered out and only untagged entries remain. That is the correct
reading — there is nothing to announce about tracking that has not started —
and it degrades to an empty list, which renders nothing.

### 5. Returning: the Home line

`apps/frontend/src/components/WhatsNewLine.tsx`, rendered beside
`<InstallBanner />` at the foot of **day-mode** Home.

That placement does three jobs at once:

- Day-mode Home returns early into `<NightHome>`, so the row is
  automatically absent at 03:00 — no night check to write and none to
  forget.
- It is the slot already occupied by `InstallBanner`, under the comment
  *"Day-mode Home only: night mode is three actions and nothing else."*
- Nothing above it moves. Status cards and the 2×2 grid are untouched,
  which is the constraint that matters: this feature may not add a tap to
  logging a feed.

Visually it follows the `ClosedDayLine` idiom — icon chip, one line of
text, hairline border — with two differences: it is tappable, and it
carries its own **×**.

```
┌──────────────────────────────────────────────┐
│ ✨  3 new things since you were away      ›  ×│
└──────────────────────────────────────────────┘
```

**The × is the point.** Dismissing never requires opening anything: one tap,
the row is gone, `whatsNewSeq` is written to `highestSeq`. For someone who
opened the app to log a bottle and go back to bed, that is the entire
interaction.

The × can be that aggressive only because dismissal loses nothing (§7).

Copy is `t()`-keyed and count-aware: "1 new thing" / "N new things since you
were away".

### 6. Returning: the list at `/whats-new`

A route inside the app shell (session required, like every other app
screen): a plain scrollable list of **every** entry ever written, newest
first, grouped under a version heading. Not a carousel — three cards in a
column are read in one glance.

Entries are relevance-filtered here too, so the page never advertises
features the family has switched off. It is not filtered by `seq` — the
whole history is always available.

Arriving here from the Home line writes the marker (you have now seen them).
Arriving from Settings does not change anything, because there was nothing
being nagged about.

### 7. Where it lives afterwards

Dismissal controls the **nag**, never the **content**. Three ways back:

1. A **What's new** row on `/profile` (Settings → You), beside Install — the
   same family of "about this app" rows.
2. The version string already rendered in the Settings hub
   (`· Pjokk v0.47.0`, `screens/settings/index.tsx`) becomes tappable and
   lands on the same page. The version number is exactly the thing a person
   would tap to ask what is in it.
3. A **Getting started** row on `/profile` that re-runs the first-run
   carousel, for someone who skipped it and wishes they hadn't.

### 8. First run: the full-screen carousel

For a caretaker with `onboarded === false`, `/getting-started` is a
full-screen paced carousel — four to five cards ending on a Done — with a
visible **Skip** in the corner. Both Done and Skip set `onboarded: true` and
land on `/home`.

This mirrors what a founder already gets from the tracking carousel, and
sits outside the app shell alongside `/welcome`.

**Routing.** `AppChrome` redirects to `/getting-started` when
`me.data.onboarded === false`, before `<Outlet/>`, once `me` has settled.
The kiosk check in `AppShell` runs first and is unaffected — an enrolled
tablet holds no person's session and can never reach this.

**Founders do not see it.** `Welcome.tsx` sets `onboarded: true` in the same
call that creates the baby, before navigating to the tracking carousel.
Without that the founder would be redirected out of the tracking flow and
into a second carousel — back-to-back carousels being the wall this design
exists to avoid. Founders are also the most motivated person in the family:
they chose to self-host a baby tracker. The invitee arriving cold is the one
who needs orientation.

**If both states are somehow true** — a brand-new account and pending
release entries — getting-started wins, and finishing it also writes
`whatsNewSeq = highestSeq`. A new account is never shown release notes for
versions it never missed.

### 9. The `Carousel` extraction

`TrackingCarousel.tsx` is 211 lines, of which roughly 60 are a genuinely
generic shell: the scroll-snap strip, the dots, Back/Next/Done, and the
`target`-ref plus `scrollend` logic that stops Done flickering back to Next
when a swipe interrupts a programmatic scroll.

Lift that into `apps/frontend/src/components/Carousel.tsx`:

```ts
type CarouselProps = {
  steps: ReactNode[];
  onFinish: () => void;
  finishLabel?: string;
  testIdPrefix: string;   // "tracking" | "getting-started"
};
```

`TrackingCarousel` then renders its feature cards through it and must come
out **behaviour-identical**, with `tracking-strip`, `tracking-next`,
`tracking-done` and `use-recommended` preserved so the existing tracking
e2e spec is the guard on the refactor.

Being honest about the risk: that component contains real, already-solved
scroll-timing bugs, and touching it is the riskiest part of this change. It
earns its keep only because first run needs a second carousel. It would not
be worth doing otherwise, and the returning-user flow deliberately does not
use it.

## Testing

**Go** — `apps/server/internal/api/me_whats_new_test.go`, descending from
`me_units_test.go`:

- `whatsNewSeq` round-trips through GET/PATCH `/api/me`.
- **The `GREATEST` guard**: PATCH 7, then PATCH 3; assert it stays 7.
- `onboarded` round-trips both directions.
- A PATCH omitting both leaves both untouched.
- Migration: a row created before `00034` comes out with
  `onboarded_at = created_at` and `whats_new_seq = 0`.

**Frontend unit** — `apps/frontend/test/whats-new.test.ts`:

- `pending` filters by seq, exclusive at the boundary.
- `pending` drops entries whose `feature` is absent from the union, and
  keeps entries with no `feature` at all.
- Empty entry list, and a marker above every entry, both yield `[]`.
- `highestSeq` over an empty list is 0.

**e2e**:

- The existing tracking spec, unchanged, as the refactor guard.
- New spec: the line appears for a seeded stale marker; **×** dismisses it
  without navigating; the dismissal survives a reload; the line is absent in
  night mode; `/whats-new` lists entries regardless of the marker.

**i18n** — `bun run check` fails until every `t()` string has its `nb`
entry. This is the mechanism that keeps the channel bilingual by
construction rather than by discipline.

## Deliberately not built

- **A backlog of historical entries.** Tempting, and it is how this feature
  becomes the wall it was designed to avoid.
- **Admin-authored entries.** A `whats_new` table with a `/admin` editor
  would allow publishing without a deploy, at the cost of a migration, CRUD,
  a screen, and the loss of the `t()` translation gate — release notes would
  be hand-written into a textarea in two languages. Bundled content cannot
  drift from the build that contains the feature.
- **Per-family or per-device markers.** The marker is the person's, like
  `units` and `language_mode`. Dismiss on the phone, the tablet stays quiet.
- **A modal, a sheet that opens itself, or any interstitial for a returning
  caretaker.** See the invariant.
- **Push notifications for new releases.** Push is for a baby who needs
  something, not for us.
- **Read receipts per entry.** One integer, not a set. The set grows
  forever and buys nothing.
