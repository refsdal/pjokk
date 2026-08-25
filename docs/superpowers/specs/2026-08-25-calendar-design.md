# Calendar (Premium) — Design

**Date:** 2026-08-25
**Status:** Approved for implementation planning
**Feature:** Shared family calendar for planning baby-related dates (doctor
appointments, vaccinations, babysitting, family events). Manual entries only.
Premium-gated.

## Goals

- One shared, family-wide calendar per family (organization). Household members
  plan together: anyone can view; premium families can create.
- Month/week overview plus an upcoming list, mobile-first, consistent with the
  app's calm visual language and nb-NO conventions (Monday start, 24 h clock).
- Optional push reminder before an event, reusing the existing web-push + cron
  infrastructure.

## Non-goals (v1, decided explicitly)

- No recurrence rules.
- No multi-day events (all-day events are single-day).
- No ICS export/subscription.
- No timeline integration (calendar is future-facing, timeline past-facing).
- No calendar entry point on the More sheet (the More sheet is for logging).
- No external calendar sync; manual entries only.

## Data model

Hand-written migration `0009_calendar.sql` in the style of 0007/0008 (the
drizzle-kit snapshot is stale — do not trust a generated diff). Three tables:

### `calendar_event`

| column | type | notes |
|---|---|---|
| `id` | text PK | same id scheme as other domain tables |
| `family_id` | text NOT NULL | FK → `organization(id)` ON DELETE cascade |
| `created_by` | text NOT NULL | FK → `user(id)`; attribution ("by <name>") |
| `title` | text NOT NULL | |
| `description` | text NULL | |
| `location` | text NULL | |
| `category` | text NOT NULL default `'other'` | `doctor \| vaccination \| babysitting \| family \| other` |
| `start_time` | integer NOT NULL | ms epoch; for all-day events the client sends local midnight |
| `all_day` | integer NOT NULL default 0 | boolean; when set, `duration_min` is NULL |
| `duration_min` | integer NULL | duration in minutes; NULL for all-day |
| `remind_minutes_before` | integer NULL | NULL = no reminder |
| `reminded_at` | integer NULL | idempotency latch for the reminder sweep |

Index: `(family_id, start_time)`.

### `calendar_event_baby`

`(event_id, baby_id)`, PK on the pair.
`event_id` FK → `calendar_event(id)` ON DELETE cascade.
`baby_id` FK → `baby(id)` ON DELETE cascade.

Zero rows for an event = family-wide. One or more rows = the babies the event
concerns (twins to the same checkup). Deleting a baby removes only its link
rows; the event survives and degrades toward family-wide.

### `calendar_assignee`

`(event_id, user_id)`, PK on the pair.
`event_id` FK → `calendar_event(id)` ON DELETE cascade.
`user_id` FK → `user(id)`.

Responsible household member(s). Zero rows = nobody assigned. A join table
(not a JSON column) for referential integrity, matching the repo's relational
style.

### Operational notes

- Add `calendar_event`, `calendar_event_baby`, `calendar_assignee` to
  `BACKUP_TABLES` in `scheduled.ts` (hardcoded list; silently omits forgotten
  tables).
- Multi-row writes (event + baby links + assignees) go through D1 `batch()` —
  the sanctioned no-transactions pattern. Structure so partial failure is safe:
  event row first, link rows after.

## API + entitlements

New `src/worker/routes/calendar.ts` modeled on `sleep-locations.ts`
(family-level entity, hand-written scoped helpers in `db/scoped.ts`, zod
schemas in `src/shared/schemas.ts`, routes chained onto `domainApp` in
`worker/index.ts`). All routes behind `requireFamily`; all Drizzle access via
the family-scoped helpers.

- **`GET /api/calendar/events?from=&to=`** — single range endpoint serving both
  the grid (month window) and the upcoming list (now → +90 days). No cursor
  pagination — family calendars are dozens of rows, not thousands. Response
  events include `babies: {id, name}[]`, `assignees: {userId, name}[]`, and
  `createdByName`.
- **`POST /api/calendar/events`** — gated: `canUse(family, "calendar")` else
  `402 { error, code: "PLAN_REQUIRED" }` (declare the 402 response in the
  route spec like the other gated endpoints). Body includes `babyIds: string[]`
  and `assigneeUserIds: string[]`; validate that ids belong to the family
  before writing.
- **`PATCH /api/calendar/events/:id`** — ungated (soft-lock rule: only
  creation is premium; downgraded families keep edit). Assignee/baby updates
  replace-on-write (delete + insert in one `batch()`).
- **`DELETE /api/calendar/events/:id`** — ungated.

Entitlements change: add `"calendar"` to the `Feature` union and
`requiresPremium` map in `src/worker/entitlements.ts` (premium-required).

## Frontend

### Navigation

- Fifth tab: `/calendar` between Timeline and Stats in `TabBar`'s `mainTabs`,
  icon `IconCalendar` (Tabler). Route added in `router.tsx` as a lazy route
  (`lazyRouteComponent`, like Stats).
- Free-tier experience: tab visible with a small lock badge; the page renders
  a calm upsell preview linking to Settings → Billing (`usePremium()` gate,
  consistent with the growth chart and grayed More tiles). Server enforcement
  via the 402 on create.

### Calendar screen (`src/web/screens/Calendar.tsx`)

- Month ⇄ week toggle at the top (same `ChipGroup` toggle pattern as the Stats
  chart's week/month switch). Monday week start, `nb-NO` formatting via the
  existing `lib/time.ts` helpers.
- **Month view:** compact grid; days with events show category-tinted dots.
  Tapping a day selects it and filters/scrolls the list below.
- **Week view:** seven day columns/rows with event chips.
- **Upcoming list** below the grid: day-grouped, dense ~44 px rows with
  hairline dividers (timeline styling). Each row: category icon + tint, title,
  time range or "All day", location line when present, assignee names, and
  "by <creator>" attribution. Tap → edit sheet.

### Event sheet (`components/sheets/`, vaul)

One component for create and edit (app convention):

- Title text field (keyboard unavoidable here).
- Category chips (Doctor / Vaccination / Babysitting / Family / Other).
- All-day toggle; when on, hide time + duration.
- Date + time pickers; duration chips 30 m / 1 h / 2 h / custom stepper.
- Location (optional), description (optional).
- **Responsible:** multi-select member chips — a new multi-select variant of
  `ChipGroup` (first in the app). Members from `useMembers()`.
- **Babies:** multi-select baby chips, same variant. Shown only when the
  family has >1 baby; a single-baby family's sole baby is silently attached on
  create. With several babies the chips start empty (= family-wide).
- Reminder chips: Off / 1 h before / 1 day before
  (`remindMinutesBefore` = null / 60 / 1440).
- Full-width Save at the bottom; 44 px+ touch targets.

### i18n

Every new user-facing string through `t()` with an `nb` dictionary entry —
`scripts/check-i18n.mjs` fails CI otherwise.

## Reminders

New sweep function in `scheduled.ts`, called from the existing `*/15 * * * *`
cron branch alongside feed reminders:

1. Select events where `remind_minutes_before` IS NOT NULL, `reminded_at` IS
   NULL, and `start_time − remind_minutes_before·60000 ≤ now`, with a grace
   window: skip (and latch) events whose `start_time` is more than 60 minutes
   in the past — no late-firing reminders after downtime.
2. Push via existing `pushToUser` to the **assignees if any, otherwise all
   family members**, with title/body from the event and `url: "/calendar"`.
3. Set `reminded_at` (idempotency latch, same approach as `lastRemindedAt` on
   feed reminders).

15-minute precision is inherited from the cron and accepted.

## Testing

Colocated vitest-pool-workers tests (`test/`), priorities per project
conventions:

- **Tenancy isolation:** family A cannot read, update, or delete family B's
  events; baby/assignee ids from another family are rejected on write.
- **Gating:** free plan gets 402 on create; edit/delete/list remain open on
  free (soft-lock rule).
- **Assignee/baby replace-on-update:** PATCH with new id sets replaces link
  rows exactly.
- **Reminder sweep idempotency:** fires once per event, respects the
  `reminded_at` latch, respects the grace window.

## Decision log

- Family-wide events with optional multi-baby attachment (join table; twins
  use case) — chosen over strictly-per-baby and no-baby-link models.
- Fifth tab — chosen over a More-sheet tile or a Home card; the four-tab IA is
  deliberately amended for a glance-often planning surface.
- Month + week toggle in v1 (user preference over month-only).
- Visible tab + upsell page for free tier — chosen over hiding the tab or
  read-only free access.
- Bespoke module — chosen over generalizing `logCrud` (would destabilize six
  existing log types and still not fit) or shipping events as an "other log"
  kind (wrong grain: past-facing, per-baby).
- Single range endpoint, no cursor pagination — deliberate YAGNI given data
  volume; avoids inventing an ascending-keyset helper.
- Push reminder included in v1 at user request (single per-event lead time,
  household-targeted).
