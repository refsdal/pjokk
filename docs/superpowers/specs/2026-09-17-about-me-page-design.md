# "About <name>": one page for the barnehage

Issue #109, sixth step of the barnehage series. Before tilvenning a
barnehage asks every family for the same list: sleep routines, how the
child falls asleep, comfort items, what and how much she eats, allergies,
medicines, contacts. A family that has logged for a year already has most
of that in Pjokk and still writes it out by hand.

Built autonomously at the owner's request on 2026-09-17; the decisions
below are recorded for him to overrule.

## The page

One A4, built in the browser with the lazy-loaded jsPDF the report uses
(`lib/about-me-pdf.ts`), never on the server. File name
`pjokk-<baby>-about.pdf`. Sections, each only when it has something to say:

1. **From us** — four free-text lines the logs cannot know: comfort items,
   how she falls asleep, allergies and diet, anything else.
2. **Sleep, as logged the last two weeks** — usual wake-up, usual bedtime,
   naps a day, the long nap (start and length), where she usually naps.
3. **Food, as logged the last two weeks** — meals, bottles (with the usual
   amount) and breastfeeds a day; what she eats; what she has reacted to.
4. **Medicines and supplements** — the catalogue's live entries with the
   family's own dose and interval. No dosing data of the app's own.
5. **Contacts** — the address book's entries that have a phone number.

## What "usual" means

`lib/about-me.ts`, pure and unit-tested, because a stranger will plan a
child's day by these lines.

- **A median, never a mean.** One 04:30 start to the day must not move the
  wake-up line.
- **Rounded to five minutes**, which is what a median means to a reader.
- **At least three days behind every figure**, or the line is left out:
  two naps are an anecdote, not a routine.
- **The day's longest nap is "the nap"**; catnaps count towards naps a day.
- **A night logged in two stretches** starts at the first and ends at the
  last waking. Bedtimes either side of midnight average to midnight.
- **A reaction never expires.** Every other line looks at the last two
  weeks; "has reacted to" looks at everything.

## The preview is the page

Settings → Data → "About the child, for daycare". The card shows the four
text fields and then every section exactly as it will print, each with an
Included / Left out switch. One list (`aboutSections`) feeds both the
preview and the PDF, so what a parent ticks is what gets printed. Nothing
leaves the device but the file the parent chooses to print or send.

## Where the four lines live

`baby_about(baby_id PK, family_id, comfort, falls_asleep, diet, other)`,
its own table rather than columns on `baby`: every reader of a baby row,
and its full-row `UPDATE … RETURNING *`, stays as it is, and the text is
fetched only where it is edited and printed. `GET` / `PUT
/api/babies/{id}/about`; blank is stored as NULL; any member may write it.
Making the page saves the lines first.

## Not here

Members' own phone numbers (private to their profile), photos, charts, a
server-rendered version, or a share link. The medicine sheet with signature
lines (#113) is a separate page.
