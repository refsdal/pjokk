# The handover at pick-up, and appetite on solids

Issues #106 and the first item of #113, second step of the barnehage
series. At pick-up the staff give a verbal report: "slept 11:40 to 13:10,
ate well at lunch, three nappies, a bit tired". Logging that today means
three sheets and three back-dated times, so nobody does it and every
weekday leaves a hole in Timeline and Stats. This is one sheet that writes
ordinary rows.

Built autonomously at the owner's request on 2026-09-17; the decisions
below are recorded for him to overrule.

## Appetite (#113, its own PR, first)

A barnehage reports a meal as "ate well / some / little", and nobody
weighs a toddler's lunch.

- `feed_log.appetite text NULL CHECK (appetite IN ('well','some','little'))`.
  NULL is "not recorded", like every optional detail column.
- Optional on the create and update bodies (nullable on update, to clear),
  present on `FeedLog` and the timeline entry, and in the CSV export's
  `detail` column beside the food.
- The solids sheet gains one chip row, "Ate", under the food field. It
  never prefills: it is an observation of THIS meal, like `reaction`.
- Timeline: "Solids · 40 g · porridge · ate well".
- Only on solids. A bottle has millilitres and a breastfeed has minutes.

## The handover (#106)

### Rows that know where they came from

`sleep_log`, `feed_log` and `diaper_log` gain `daycare_id text NULL
REFERENCES daycare_log(id) ON DELETE SET NULL`. A row with it set was
reported by the barnehage, not done by a member:

- Its `caretaker_id` and `logged_by_id` are the person who saved the
  handover (both columns are NOT NULL and must be a member; the staff are
  not users and never will be). The SPA shows "at barnehage" in place of
  "by <name>" for such a row, so nobody is credited with a nap they did not
  give. A future leaderboard counts rows `WHERE daycare_id IS NULL`.
- Deleting the day keeps the rows (SET NULL): the nap happened.
- `daycare_log` gains `mood text NULL CHECK (mood IN ('good','ok','hard'))`.

### One endpoint, replace semantics

`PUT /api/daycare/{id}/handover`, `GET` the same. `tierFamily`, not for
devices.

```
Handover {
  naps:    [{ startTime, endTime }]          // 0..4
  meals:   [{ time, appetite?, food? }]      // 0..6
  diapers: { wet: 0..10, dirty: 0..10 }
  mood:    good | ok | hard | null
}
```

- **PUT replaces.** In one transaction: delete the day's linked rows,
  insert the new ones, set the mood. That makes the sheet's edit path the
  same as its create path, and makes a replayed offline mutation harmless:
  the second PUT writes what the first did.
- Naps become `sleep_log` rows, `type = nap`, `location = 'Barnehage'`
  (the word is the family's data, written by the server in one language on
  purpose: it is a place name, and the sleep-location chips are free text
  already). A nap must end after it starts (400 `BAD_NAP`).
- **A handover is about the hours she was there.** A nap or a meal outside
  the day — before the drop-off (widened to its minute, because the sheet
  speaks in whole minutes) or after the pick-up, or after now for a day
  still running — is refused (400 `OUTSIDE_DAY`). Not pedantry: a usual
  11:30 nap saved for a child fetched at 09:30 with a fever is a sleep in
  the future, and Home's Awake card counts from its end.
- Meals become `feed_log` rows, `type = solids`, no amount.
- Diapers have a count, not times. They are spread evenly across the
  session (the n-th of N at `start + n·span/(N+1)`), wet first. The link
  to the day is what says the time is approximate.
- A row the family later edits by hand through its own sheet stays linked;
  a row they delete is gone, and the next GET simply no longer lists it.
- GET rebuilds the Handover from the linked rows, so there is no second
  copy of anything to drift.

### The SPA

- **Offered at pick-up.** `/api/summary` gains `handoverDue: DaycareLog |
  null`: the newest day that ended within the last 12 hours and has no
  linked rows and no mood. Home shows a quiet card under the banners,
  "How was the day at barnehage?", with **Add** and a dismiss (per device,
  keyed by the day's id). Also reachable from the day's edit sheet
  ("Handover"), where it edits.
- **`HandoverSheet`**, top to bottom: nap (start and end clock fields, a
  "No nap" chip, "+ nap" for a second), meals (Breakfast / Lunch / Snack
  rows, each an appetite chip group; tapping one includes the meal),
  diapers (two steppers, wet and dirty), mood chips, Save. Everything
  optional; saving nothing is allowed and only dismisses the card.
- **Last-value prefill.** Nap clock times and meal clock times come from
  the previous day's handover; without one: nap 11:30–13:00, meals 08:30 /
  11:00 / 14:00. Only what fits the hours she was there is offered: a
  usual nap that does not fit is left out, a meal slot outside the day is
  not shown, "Add a nap" after an early pick-up adds the last hour and a
  half, and a nap typed outside the day blocks Save with a line saying
  when she was there. Appetite, diaper counts and
  mood never prefill: they are observations of this day.
- Meal times are not editable in the sheet (v1). The rows are ordinary
  feeds and open in the feed sheet from the timeline.
- Timeline rows with `daycareId` read "at barnehage" where "by <name>"
  would be. Home's Last diaper card gains "from the barnehage handover"
  when its entry is such a row, because its time is an estimate.

## Testing

- Go: appetite round-trip, validation and export; handover PUT creates the
  rows, PUT again replaces rather than doubles, GET mirrors, tenancy (404
  across families), the three caps, nap validation, rows survive the day's
  deletion unlinked, `handoverDue` appears and clears. Account deletion and
  the table guards need nothing new: no new table, no new user column.
- SPA unit: the diaper spread is the server's; the SPA tests the prefill
  and the "at barnehage" attribution rule.
- e2e: pick up, tap Add on the card, fill a nap, a lunch and two wet
  nappies, save; the timeline shows the three kinds "at barnehage" and the
  card is gone; reopen from the day and see it prefilled.
