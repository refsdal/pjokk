# Who did it, not only who logged it

Every log row has always carried one person: `caretaker_id`, the session
user who saved the entry, shown on the timeline as "by <name>". A parent
often logs for the other one ("she changed the nappy while I typed"), so
the row was a record of who held the phone, not who did the care. This
adds the second person and shows the right one. A household leaderboard
can be built on it later; it is not part of this work.

Designed in conversation with the owner on 2026-09-14; the decisions below
are his.

## The model

- **`caretaker_id` keeps its name and now means "who did the care".** The
  word already described that person, and every reader — the timeline,
  the CSV export, the PDF report, the kiosk's caretaker row, the future
  leaderboard — keeps reading the column it reads today. Rejected: a new
  `performed_by` column beside an unchanged `caretaker_id`, which would
  have moved every reader to a second column and left API-key integrations
  with a field whose meaning no longer matched what the app shows.
- **A new `logged_by_id` records who saved the row.** Every log table
  (sleep, feed, diaper, medicine, bath, note, milestone, measurement, pump,
  play, vaccine) and `feed_timer` get `logged_by_id text NOT NULL
  REFERENCES users(id)`, backfilled from `caretaker_id`: every historical
  row reads as "did it and logged it", which is the truth as far as anyone
  knew. It is set by the server from the family context and is never
  client-settable, on create or on edit.
- No new table, so backup, restore and account deletion need no
  registration; `backup_tables_test.go` and the restore rules are
  unaffected.

## The API

Backwards compatible: nothing a client sends today changes meaning.

- Every create body and every update body gains an optional `caretakerId`.
  Absent on create means the session user; absent on update means
  unchanged. `StartFeedTimer` takes it too.
- Every log response and every timeline entry gains required `loggedById`
  and `loggedByName` beside the existing `caretakerId` / `caretakerName`.
- A `caretakerId` that is not a member of the family answers
  `403 NOT_MEMBER`, the same check and code the kiosk middleware already
  uses for its header.
- `loggedById` is always the family context's user: the session user, the
  API key's owner, or the kiosk's chosen caretaker. A kiosk row therefore
  has both columns equal, and the kiosk itself changes nothing — its
  caretaker row already meant "who did it".
- Timers: the feed or pump row written on stop takes the timer's caretaker
  as who did it and the stopper as who logged it. Today the stopper got
  both. Stopping a sleep or play session does not change who did it.
- The CSV export gains a `logged_by` column after `caretaker`. The PDF is
  unchanged.
- Importers write `logged_by_id` equal to `caretaker_id` for every log row
  in both fixed-id and resolve-by-email mode; no reader changes.

## The sheets

- A shared `CaretakerChips` component, lifted from the kiosk's caretaker
  row: a horizontally scrolling row of avatar-plus-first-name pills. It
  renders nothing when the family has one member, so a single parent never
  sees an extra row and the two-tap happy path stays two taps.
- Every log sheet places it between the time field and the note, defaulting
  to the signed-in user on create and to the entry's caretaker on edit.
  A sheet sends `caretakerId` only when the choice differs from that
  default, so an untouched form sends the body it sends today.
- "Logged by" is visible in exactly one place (decided, over "nowhere" and
  "on the timeline row"): in edit mode, a muted "Logged by <name>" line
  under the chips, shown only when it differs from the chosen person.
- The timeline row keeps rendering `caretakerName` and that person's
  avatar, which is now who did it. Its markup does not change.
- Paused offline mutations carry their variables, so a chosen person
  survives the queue.

## Tests

- Go, on one representative kind and the generic engine: a create without
  `caretakerId` records the session user in both columns; a create naming
  a partner records the partner as caretaker and the session user as
  logger; a non-member answers 403; an update changes the caretaker and
  leaves the logger alone; a timer stop inherits the timer's caretaker; a
  kiosk write has both columns equal.
- SPA: the chooser hides for a single-member family, defaults correctly,
  and an untouched sheet omits `caretakerId`. One e2e flow logs a diaper
  for a partner and sees their name on the timeline.
