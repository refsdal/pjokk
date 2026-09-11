# Importing history from another tracker

Pjokk is a replacement, and a family with eight months of history will not
switch if switching means starting at zero. Every importer here is a
one-off command-line script that reads the other app's export and writes a
**SQL file for you to review and apply** — never an upload endpoint.
Importing four thousand rows is an admin action, and reading the file
first is the safety net.

All importers share one writer (`scripts/lib/import-writer.mjs`), so they
behave the same way:

- **Deterministic ids** (`st-…` for sprout-track, `bb-…` for Baby Buddy) and
  `ON CONFLICT DO NOTHING`, so re-running never duplicates. Fixing a mapping
  and re-running does **not** update rows already imported: delete the
  prefixed rows first.
- **`--resolve-by-email you@example.com`** emits SQL that looks the family
  and the caretaker up at apply time and aborts the transaction unless it
  matches exactly one (user, family). Everything is attributed to that one
  account. The alternative is naming ids yourself (`--family`,
  `--caretaker`, `--baby`).
- **`--create-babies`** creates each source child under a deterministic id.
- **Units are normalised** to Pjokk's canonical ml / kg / cm / °C on the way
  in. Display units are a per-person preference in the app, never a row.
- **The export is untrusted input.** Every value becomes SQL at one
  boundary that refuses anything it cannot prove is a number, NULL, a
  boolean or a properly quoted string, so a malformed or crafted export
  aborts the run rather than writing its own SQL. A cell that should be a
  number and is not imports as NULL and is counted in the summary.
- **Lossy on purpose, preserved in notes.** Anything Pjokk has no column
  for is folded into the entry's notes rather than dropped, and the summary
  printed at the end lists everything skipped, and why.

Apply with:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f pjokk-import.sql
```

## sprout-track

Source: the SQLite database file of a sprout-track instance.

```sh
node scripts/import-sprout-track.mjs sprout.db --inspect
node scripts/import-sprout-track.mjs sprout.db \
  --resolve-by-email you@example.com --create-babies --out pjokk-import.sql
```

Imports feeds (incl. the separate FoodLog as solids), diapers, sleep,
notes, milestones, pumps, baths, measurements, medicines (and the medicine
catalogue), play, vaccines, contacts and calendar events. Not imported:
moods, allergens, freezer inventory, photos, settings, and vaccine document
files (sprout stores those encrypted outside the database). The script's
header comment carries the full column-by-column mapping.

## Baby Buddy

Source: CSV files from Baby Buddy's admin. Open each list you want (Feeding,
Diaper Change, Sleep, Temperature, Weight, Height, Head Circumference,
Pumping, Note, Tummy Time, Medication, Child) and use **Export → CSV**.
One file per model; the child comes along in every row as `child_id`
plus first and last name, so `--create-babies` works without the Child
export — but export Child too, or the babies arrive without a birth date.

Baby Buddy writes every timestamp in its server's time zone with no
offset, and stores amounts, weights, lengths and temperatures **without a
unit** (each family picks its own). Say what they were:

```sh
node scripts/import-babybuddy.mjs feeding.csv sleep.csv diaperchange.csv child.csv … --inspect
node scripts/import-babybuddy.mjs *.csv \
  --resolve-by-email you@example.com --create-babies \
  --tz Europe/Oslo --volume ml --weight kg --length cm --temperature c \
  --out pjokk-import.sql
```

`--tz` defaults to the machine's zone; the unit flags default to metric.

Mapping: feeding type → bottle contents (formula / breast milk; fortified
breast milk → mixed with a note), method → bottle or breast with the side,
"solid food" → a solids feed whose amount is taken as **grams** whatever
`--volume` says; wet + solid → both / wet / dirty / dry; colour 1:1; nap
flag → nap / night; weight, height and head dates land at noon in `--tz`;
tablets → dose; the next-dose interval and tummy-time milestone become
notes. Tags are dropped and counted; BMI rows are skipped (derived);
pictures and note images are not in Baby Buddy's CSV.

## Huckleberry

Source: one CSV per child. In the app, open the child profile, scroll to
**Export tracking data as CSV**; the link arrives by email and lasts 24 h
([Huckleberry's help article](https://huckleberry.zendesk.com/hc/en-us/articles/5055945148819)).

Huckleberry does not document the file. The reader was written against a
real export its owner published ([archiewood/baby-tracker](https://github.com/archiewood/baby-tracker/blob/main/sources/huckleberry/events.csv),
about 3 600 rows) and cross-checked against four independent open-source
parsers of the same format ([richardqhill/huckleberry-to-posthog](https://github.com/richardqhill/huckleberry-to-posthog),
[matthewsmorrison/baby-tracker](https://github.com/matthewsmorrison/baby-tracker),
[murphb52/BabyTracker](https://github.com/murphb52/BabyTracker),
[anaandresarroyo/baby-tracker](https://github.com/anaandresarroyo/baby-tracker)).
A row shape none of those show is skipped and counted, never guessed.

Timestamps are the phone's local time with no offset, so say the zone:

```sh
node scripts/import-huckleberry.mjs nora.csv --inspect
node scripts/import-huckleberry.mjs nora.csv \
  --resolve-by-email you@example.com --create-baby "Nora" --birth-date 2026-06-15 \
  --tz Europe/Oslo --out pjokk-import.sql
```

Mapping: bottle feeds (ml or oz) with Formula / Breast Milk / Mixed as the
contents; nursing with per-side minutes; solids with the food list;
diapers as pee → wet, poo → dirty, both → both, with the colour and the
sizes ("pee:large") kept in notes; growth rows become weight, length and
head measurements (kg / lb, cm / in / decimal feet); pumps sum both sides
and note the split; meds keep the name and the dose; tummy time → play;
baths. Sleep rows carry no nap/night flag in Huckleberry and import
untyped; a sleep's "Start Location" text becomes the sleep location. The
export has no row ids, so Pjokk ids are a hash of each row's content —
re-exporting the same data gives the same ids.

## Nara

Nara exports CSV from Activity → child avatar → Export Data, but the column
names are not documented anywhere public and no open-source project reads
the file, so Pjokk ships **no Nara reader yet**. If you have an export,
please attach a header row and a few anonymised lines to the tracking
issue and a reader will be written against the real file — the Huckleberry
and Baby Buddy readers are the templates.

## Baby Daybook and Napper

Baby Daybook has no documented CSV export (its Android app backs up an
SQLite file to Dropbox). Napper has no export at all. Neither is supported.
