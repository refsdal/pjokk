# The barnehage as a place, a pick-up plan, and a closing-time alert

Follows the barnehage series (#105–#113, #125–#127). The session from
drop-off to pick-up (`daycare_log`, spec
`2026-09-17-daycare-session-design.md`) says WHERE she is. It does not know
what the place is, when it closes, or who is meant to collect her. This
adds those three, and one push: she is still there and it is about to
close.

Designed with the owner in conversation on 2026-09-17; his decisions are
marked **(owner)**. Everything else is mine to be overruled.

## Decisions

- **A fixed weekly pattern (owner).** Who collects mostly follows the
  weekday. The plan is a Monday-to-Friday grid per baby, not calendar
  events: a rota that differs by weekday would need several weekly series,
  and nothing marks a calendar event as a pick-up.
- **A small exception, not a workflow (owner).** "Who collects today" is a
  chip row any member can set; one row per baby and date. Rare by his own
  account, so it lives on the day sheet and costs nothing when unused.
- **The push goes to the planned person only (owner).** Today's exception,
  else the grid's person, else the parents (family admins). A named person
  who is no longer an unbanned member reads as nobody. No second,
  escalating push.
- **The expected time is display only (owner).** It is a plan, not a
  deadline; the only push is the closing one.
- **One opening and one closing time** for all weekdays; **one place per
  baby**; **parents edit, everyone reads**, and any member may set today's
  exception.
- **Not Contacts.** `contact` has a daycare icon, but hours, a zone and a
  per-baby link are not address-book fields and nothing reads contacts. An
  existing daycare contact is left alone; nothing is imported.
- **No Snooze on this push.** Closing time does not move. No kiosk access:
  nothing here joins `deviceOperations`.

## The model

```
daycare_place(
  id, family_id -> organizations CASCADE,
  name text not null, address, phone, email, website, notes text null,
  open_minute  int null check 0..1439,   -- minutes after local midnight
  close_minute int null check 0..1439,
  alert_lead_min int null check 5..180,  -- NULL = no closing alert
  tz text not null,                      -- IANA, from the creating device
  created_at
)
daycare_enrolment(
  baby_id PRIMARY KEY -> baby CASCADE,   -- one place per baby
  family_id -> organizations CASCADE,
  place_id -> daycare_place CASCADE
)
daycare_pickup_plan(
  family_id, baby_id -> baby CASCADE,
  weekday int check 1..5,                -- ISO: 1 = Monday
  pickup_minute int null check 0..1439,
  user_id text null -> users SET NULL,
  PRIMARY KEY (baby_id, weekday)         -- a day with neither is no row
)
daycare_pickup_override(
  family_id, baby_id -> baby CASCADE,
  date date,                             -- the client's local day
  user_id text not null -> users CASCADE,
  PRIMARY KEY (baby_id, date)
)
daycare_log.closing_alerted_at timestamptz null   -- the latch
```

- The place carries a zone for the reason a reminder does: the server has
  none, and "closes 16:30" is a wall-clock fact. `alert_lead_min` is the
  family's own number, default 30 from the SPA.
- The override's `date` is a calendar DATE sent by the client, the
  `care_day` rule. The alert job, which does have the place's zone,
  compares against the local date there.
- A removed member is cleared from both tables inside `RemoveMember`'s
  transaction (the plan row keeps its time and loses the person; the
  override is deleted). Overrides older than 30 days are pruned by the
  nightly job.
- Registrations: all four tables in `backup.go`; each has `family_id`, so
  the family restore classifies them; `daycare_pickup_override` is
  `userOwned`. No non-cascading user reference, so
  `ReassignUserReferences` is untouched.

## The API

| Operation | Route | Tier |
|---|---|---|
| `ListDaycarePlaces` | `GET /api/daycare-places` | family |
| `CreateDaycarePlace` | `POST /api/daycare-places` | admin |
| `UpdateDaycarePlace` | `PUT /api/daycare-places/{id}` | admin |
| `DeleteDaycarePlace` | `DELETE /api/daycare-places/{id}` | admin |
| `GetPickupPlan` | `GET /api/babies/{babyId}/pickup-plan` | family |
| `SetPickupPlan` | `PUT /api/babies/{babyId}/pickup-plan` | admin |
| `SetPickupOverride` | `PUT /api/babies/{babyId}/pickup-override` | family |

- A place is written whole (a PUT, not a PATCH: the settings page holds
  every field, so there is no omitted-versus-null to tell apart). Its body
  carries `babyIds`; create and update REPLACE its enrolments in the same
  transaction, and enrolling a baby moves her from any other place (the
  primary key is the baby). Every baby must be the family's (400
  `INVALID_REFERENCE`, the contacts rule). `tz` must load (400 `BAD_TZ`).
- `PUT pickup-plan` replaces the five rows in one transaction, the
  handover's idempotent shape, so a replayed save is harmless. Every named
  person must be a member (400 `INVALID_REFERENCE`); a weekday twice is
  400 `DUPLICATE_DAY`; a day with neither a time nor a person is dropped.
- `PUT pickup-override` takes `{date, userId}`; a null `userId` clears
  the day. On the sheet, tapping the grid's own person IS the clear.
- `Summary` gains `daycare`: `{ place, plan, overrides }` for the summary's
  baby, null when she has neither a place nor a plan. `overrides` holds
  yesterday onward. The CLIENT resolves "today" with its own date, so Home
  needs no extra request, works from the offline cache, and the server
  guesses no date for display.

## The closing alert

`jobs.RunDaycareClosingAlerts`, a third step in the */15 frequent job.
Candidates: running sessions, not yet latched, whose baby is enrolled at a
place with both a closing time and a lead. In the place's zone:

- the session must have begun on the local today (yesterday's forgotten
  session says nothing about today);
- before `close - lead`: wait;
- more than an hour past closing: latch without sending, the calendar
  reminders' rule after an outage;
- otherwise send once and latch, even when every delivery failed.

Target: the override for (baby, local date), else the plan's person for
the weekday, each only while an unbanned member; else the family's
unbanned admins. The text is in the recipient's language
(`internal/push/text.go`): "<Baby> is still at barnehage" / "<Place> closes
at 16:30." (or "closed at" once past). Tapping opens Home. A pick-up ends
the session and so the candidacy; editing the hours after the latch does
not re-arm the day.

## The SPA

- **Settings → Family → Barnehage** (`settings-nav.ts`, not admin-only;
  the page is read-only for members). Place details, hours as time rows,
  lead chips (Off / 15 / 30 / 45 / 60), which babies attend, and per
  enrolled baby the Monday-to-Friday grid: a time and a person chip each.
- **Home banner.** Second line "Pick-up 15:30 · Anders"; inside the lead
  window "Closes 16:30 · in 25 min"; past closing "Closed at 16:30". Still
  no ring and no badge. View logic in `lib/daycare-ui.ts`, unit-tested.
- **The day sheet** (drop-off and the running day): a place block with
  Call and Directions links, and the "Who collects today" chips.
- Both languages in `lib/i18n.ts`; wire types aliased in
  `packages/shared`.

## Testing

Go, against Postgres: tenancy and role on every route, enrolment moving a
baby, the plan's replace, the override's set and clear, the summary shape;
the alert's targeting order, its fallback when the named person has left,
the latch, the stale latch, yesterday's session, and a clock-change day.
Frontend unit tests for the resolver and the banner line. One Playwright
spec: set up a place and a plan, drop off, see the banner line.
