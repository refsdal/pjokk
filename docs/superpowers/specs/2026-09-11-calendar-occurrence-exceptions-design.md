# Calendar: this occurrence only

Issue #52 shipped recurring events as one row expanded on read, and left
"this occurrence only" out on purpose (DECISIONS.md 2026-09-07): editing
or deleting any occurrence changed the whole series. This is that follow-up.

Built without a design conversation, on the owner's instruction to make
educated guesses and report them. Every such guess is marked **(decided)**.

## The model

- **A skip takes one occurrence out of a series.** New table
  `calendar_event_skip(family_id, event_id, occurrence_start)`, primary key
  `(event_id, occurrence_start)`, cascading with the event and the family.
  The series stays one row; `internal/recur`'s expansion, the reminder job
  and the ICS feed (as `EXDATE`) all leave skipped occurrences out.
- **Deleting "this event" writes a skip.**
- **Editing "this event" detaches it (decided):** a standalone one-off
  event is created from the series' fields with the edit applied — babies,
  assignees and reminder copied, the series' creator kept — and the
  occurrence is skipped on the series. Everything downstream already
  handles one-offs, so a detached event needs nothing new: it is its own
  VEVENT in the feed, its own reminder, its own row. Rejected: per-field
  overrides on an exception row (every reader would learn to merge them,
  and the ICS feed would need `RECURRENCE-ID` overrides).
- **Two scopes, "This event" and "All events" (decided).** "This and
  following" is not offered: ending a series is already its Until date.
- **Moving a series clears its skips (decided).** When an "All events"
  edit changes the series' start or rule, the occurrences its skips name
  no longer exist, so they are deleted; a detached event stays as it is.
  Only a real change counts — the sheet sends `startTime` on every save, and
  an unchanged value keeps the skips. Changing only Until keeps them.

## The API

Backwards compatible: a new optional `occurrence` query parameter (the
occurrence's start, as listed) on the two existing routes.

- `DELETE /api/calendar/events/{id}?occurrence=…` → skips it, `{ok:true}`.
- `PATCH /api/calendar/events/{id}?occurrence=…` → detaches it and answers
  with the NEW one-off event. Recurrence fields in the body are ignored: a
  single occurrence does not repeat.
- `400 NOT_AN_OCCURRENCE` when the event does not repeat, or the time is
  not one of its occurrences (off the rule, past Until, or already
  skipped). `404` as before for an unknown event.
- Without `occurrence`, both routes act on the whole series as today.

## The sheet

Tapping an occurrence of a recurring event opens the sheet with a chip
pair at the top: **This event** (the default, decided — it is the
occurrence that was tapped) and **All events**.

- This event: the date and time are the occurrence's; the Repeat section is
  hidden; the note says only this event changes; Save detaches, and the
  delete button reads "Delete this event".
- All events: today's behaviour — the series' start, Repeat shown, "Changes
  apply to every occurrence in the series.", "Delete all events".
- Switching scope resets the date and time to that scope's start.

## Testing

- `recur`: skipped occurrences are left out of `Between` and
  `NextOnOrAfter`; `IsOccurrence` for an occurrence, an off-rule time, one
  past Until and a skipped one.
- API: delete one occurrence (listed without it, `EXDATE` in the feed,
  400s); edit one occurrence (a one-off with the edit, links and reminder
  copied, the series without that occurrence); an unchanged start keeps
  skips, a moved start clears them.
- Reminder job: a skipped occurrence is not reminded; the next one is.
- The backup and restore guards cover the new table.
- E2E: delete one occurrence and edit another from the sheet, with the
  feed's `EXDATE`s.
