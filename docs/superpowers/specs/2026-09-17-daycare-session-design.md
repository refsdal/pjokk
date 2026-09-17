# At barnehage: a session from drop-off to pick-up

Issue #105, first of the barnehage series (#105–#113). Pjokk's daytime
model assumes a parent is present and logging. From the day a child starts
barnehage, seven to eight hours of every weekday go unlogged: Home says
"fed 7 hours ago" as if that were news, and a `since_last` feed reminder
fires at 11:00 for a feed nobody at home can give or log. This adds the
missing piece of state: where she is.

Built autonomously at the owner's request on 2026-09-17; the decisions
below are recorded for him to overrule.

## The model

A `sleep_log` clone in the way `play_log` is: active sessions are state,
not screens.

```
daycare_log(
  id                   text primary key,
  family_id            text not null references organizations on delete cascade,
  baby_id              text not null references baby on delete cascade,
  caretaker_id         text not null references users,   -- who dropped off
  logged_by_id         text not null references users,   -- who saved the row
  pickup_caretaker_id  text null references users,       -- who picked up
  start_time           timestamptz not null,             -- drop-off
  end_time             timestamptz null,                 -- pick-up; NULL = there now
  notes                text null,
  created_at           timestamptz not null default now()
)
unique (baby_id) where end_time is null     -- one running session per baby
index (family_id, start_time), index (baby_id)
```

- **One row is one day there.** Two people belong to it, so it carries
  two: `caretaker_id` is the person who dropped off (the who-did-it rule,
  `internal/api/caretaker.go`, unchanged) and `pickup_caretaker_id` is the
  person who picked up. NULL pick-up person on a finished row means "not
  recorded" and reads as nobody, never as the drop-off person.
- **Independent of sleep and play.** A child can be asleep at barnehage;
  the partial unique index is per table, so a handover nap logged
  afterwards (#106) never collides with the day itself.
- **Code says `daycare`, the UI says the family's word**: "Barnehage" in
  Norwegian, "Daycare" in English. One English identifier through the
  schema, the API and the SPA.
- **No tilvenning field.** The issue floated "time without a parent". The
  row's own span is the record of a tilvenning day and the note holds the
  rest ("alone 40 min, cried at drop-off"); a stepper that matters for two
  weeks would sit on the sheet for four years.

New-table registrations, all in the migration's commit: `backup.go`'s
table list; `admin.sql`'s `ReassignUserReferences` (all three user columns
in ONE update) and `admin_test.go`'s reference list; the family-restore
classifier needs nothing (the table has a `family_id`).

## The API

`/api/daycare`, shaped exactly like `/api/play`, tier `tierFamily`:

| Operation | Route | Notes |
|---|---|---|
| `ListDaycares` | `GET /api/daycare?babyId&limit` | newest first by start |
| `CreateDaycare` | `POST /api/daycare` | `{babyId, startTime, endTime?, caretakerId?, pickupCaretakerId?, notes?}`; no `endTime` starts a running session; 409 `ALREADY_ACTIVE` ("Already at daycare") by pre-check and by 23505 |
| `GetActiveDaycare` | `GET /api/daycare/active?babyId` | the row or bare `null` |
| `PickupDaycare` | `POST /api/daycare/{id}/pickup` | optional `{endTime?, caretakerId?}`; the pick-up person defaults to the caller; 404 when not running, so a replay is harmless |
| `UpdateDaycare` | `PATCH /api/daycare/{id}` | tri-state patch; `endTime: null` reopens (409 on collision); `pickupCaretakerId: null` clears |
| `DeleteDaycare` | `DELETE /api/daycare/{id}` | |

`pickupCaretakerId` obeys the same rule as `caretakerId`: a family member
or 403 `NOT_MEMBER`. A device's write credits its chosen face, as ever,
but the kiosk gets none of these operations: `deviceOperations` is
unchanged. A nursery tablet at home has no part in a drop-off.

`DaycareLog` on the wire: `id, babyId, caretakerId, caretakerName,
loggedById, loggedByName, pickupCaretakerId, pickupCaretakerName,
startTime, endTime, notes`.

`/api/summary` gains required, nullable `activeDaycare`. `/api/timeline`
gains kind `daycare` (sorted by `startTime`, like sleep and play, searched
on `notes`, carried under the **Other** filter). The CSV export gains a
`daycare` section.

## Reminders hold

A `since_last` reminder of kind `feed` or `diaper` **holds** while the baby
it is about is at barnehage, and a family-wide one (no baby) holds while
any baby of the family is. Held, not latched: the quiet-hours rule.

Pick-up then **answers** the reminder: the gap is measured from the later
of the last log and the last pick-up. Otherwise the 15:30 pick-up would be
greeted with "no feed for 8 h", which is wrong (she ate lunch there) and
is exactly the noise this exists to remove. With the handover entry (#106)
the logged lunch usually wins anyway.

Left alone on purpose: `pump` (about the parent, not the child),
`medicine` (a missed dose is worth knowing about wherever she is; a parent
can ring the barnehage), `at_time` and `custom` (the parent chose the
clock), and calendar reminders. A snoozed feed or diaper reminder that
comes due while she is there is dropped rather than held: by pick-up it
has been answered.

## The SPA

- **Starting.** A **Barnehage** tile in the More list (after the play
  kinds, before Vaccines), opening `DaycareSheet`: time chips for the
  drop-off, the caretaker chips, a note, and **Drop off**, which starts
  the running session. Two taps from More for the happy path. **Log a
  finished day** unfolds the pick-up time and a second chip row for who
  picked up, and the button becomes Save; folded by default, unlike the
  play sheet, because the drop-off is done at the gate with a child on one
  arm. The same component edits.
- **While it runs.** A banner on Home, "At barnehage · 5 h 20 min since
  08:10", with a **Pick up** button: one tap, now, the caller. Tapping
  the body opens the edit sheet, for a drop-off logged late. The banner is
  the calmest of the four: a plain hairline border, no ring, no breathing.
  It is on screen for eight hours a day and nothing about it is urgent.
- **Calmer cards.** While she is there, a Last feed or Last diaper card
  whose entry predates the drop-off gains the note line "At barnehage
  since then". The relative time stays: it is still true.
- **No app badge.** The badge says "something is running that you will
  want to stop". A weekday-long dot says nothing.
- **Timeline.** A span row with a duration, like sleep: "Barnehage ·
  08:10–15:40 · 7:30 · picked up by Anders", the pick-up person last
  (where a narrow row truncates first) and only when recorded, then "by
  Kari"; an "active" badge while running. Tap opens the
  edit sheet, where the pick-up person is a second chip row.
- **Offline.** Mutation defaults with an optimistic summary patch for
  drop-off, as play: a drop-off with no signal at the gate must not fail.
- **Not here:** night Home (three actions, by rule), the kiosk, hotkeys,
  the PDF report, the importers, Stats (#111).

## Testing

- Go, against the real Postgres: `daycare_test.go` for the lifecycle
  (create, 409 twice over, pick-up and its replay, reopen collision,
  tenancy: another family's row is a 404, a non-member pick-up person is a
  403), summary and timeline coverage, and `reminders_test.go` cases for
  held, family-wide held, answered by pick-up, and the kinds left alone.
  The table guards (`backup_tables_test.go`, the user-reference test, the
  family-restore rule test) pass by registration.
- SPA unit: the More-list order, the card note rule, the timeline row.
- e2e: drop off from More, see the banner, pick up, find the row on the
  timeline, reopen it and change the pick-up person.
