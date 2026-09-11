# Admin console spec 4: restore

The last of the four operator-console specs (family management, user
support, ops, restore). Backups have been written nightly since the Go
port; nothing could put one back. This spec adds the two restores a
self-hosted Pjokk needs: the whole database after a disaster, and one
family deleted by mistake.

## Decisions (made in conversation, 2026-09-11)

- **A family restore undoes a deletion, and nothing else.** It only
  restores a family that no longer exists, with its original ids. It never
  touches live data, so it cannot clash with or overwrite anything. Rolling
  a live family back was rejected: it destroys whatever was logged since.
- **The family restore runs from the console and the CLI**, through one
  implementation. The undo lives next to where families get deleted.
- **The whole-database restore only goes into an empty database.**
  `pjokk restore` migrates, then refuses if any family or real user
  exists. Starting over means pointing `DATABASE_URL` at a fresh
  database — a mistyped URL cannot wipe a live one. No `--replace`.
- **`pjokk set-password <email>`** is how an operator gets back in: the
  snapshot nulls every password hash, so after a whole restore no password
  works. It reads the password from stdin, never argv.
- **A schema-driven loader** (approach A). Postgres types the rows
  (`json_populate_recordset`), the live schema's foreign keys set the
  order, and a family restore is the same loader with a filter. A guard
  test forces a decision for every new table. Rejected: hand-written
  per-table code (a forgotten table silently loses data) and emitting SQL
  for review (the scratch image has no psql, and the console could not use
  it).

## 1. The loader and the whole-database restore

**Snapshots gain `schemaVersion`** — the applied goose version when the
backup ran. Snapshots without it (everything written before this spec)
still load, with a warning that their version is unknown.

**`internal/restore`** — the loader both restores share:

- **Source:** a date (`backups/<date>.json` in the configured storage) or
  a file (a downloaded snapshot).
- **Order:** tables load parents-first, from the live schema's foreign
  keys (`pg_constraint`). A snapshot table that no longer exists is
  skipped and reported; a table the snapshot lacks stays empty.
- **One statement per table**, in chunks of 1,000 rows:
  `INSERT INTO t (cols) SELECT cols FROM json_populate_recordset(NULL::t, $1::json)`,
  where `cols` are the table's live, non-generated columns (so
  `users.display_name` is never written). Postgres parses every type; keys
  the table no longer has are ignored; columns the snapshot lacks get
  their defaults; a NOT NULL column added since without a default fails
  naming the table.
- **`sessions` is never restored.** The snapshot nulls its tokens and the
  column is NOT NULL; a restore signs everyone out anyway.

**`pjokk restore --from DATE | --file PATH`:**

1. Migrate (under the existing advisory lock).
2. Refuse unless empty: no family, and no user but the "Deleted user"
   tombstone. The message says to point `DATABASE_URL` at a fresh
   database.
3. Load every table in **one transaction**. The migration-seeded tombstone
   is the one row that already exists: `users` loads with
   `ON CONFLICT ("id") DO NOTHING`, and nothing else tolerates a conflict.
4. **Milestone photos:** each restored `milestone_photo` row's object is
   copied back from `photo-backups/current/<rest>`, or failing that from
   the newest `photo-backups/deleted/<date>/<rest>`. An object already in
   place is left alone; a missing copy is listed, never fatal. Avatars and
   vaccine documents were never backed up and cannot come back.
5. **Report:** rows per table, skipped tables, missing photos, the
   snapshot's schema version against the build's. It ends by saying
   passwords are gone and naming `pjokk set-password`.

**`pjokk set-password <email>`** reads the new password from stdin (at
least 8 characters, the console's rule) and calls
`auth.Service.SetPassword`.

## 2. The family restore

`restore.Family(ctx, deps, snapshot, familyID)` — used by
`pjokk restore family <id> --from DATE | --file PATH` and the console.

- **Refuses** when the family exists now (`FAMILY_EXISTS`), or is not in
  the snapshot (`NOT_FOUND`).
- **Which rows are the family's**, derived from the live schema:
  - `organizations` — the row whose id is the family;
  - every table with a `family_id` or an `organization_id` column — its
    rows for the family;
  - every other table with a foreign key to one of those — the rows whose
    parent was selected (`contact_baby`, `calendar_event_baby`,
    `calendar_assignee`).
- **Never restored for a family:** `api_key`, `device` and
  `push_subscription`. They are credentials and device bindings; a family
  admin re-issues keys, tablets re-enrol, browsers re-subscribe. A deleted
  family's integrations should not quietly start working again.
- **Global tables are not touched:** `users`, `accounts`, `sessions`,
  `verifications`, `admin_audit`, and the tables the backup already leaves
  out.
- **Guard test:** every live table is family-scoped, reached through a
  parent, never-for-a-family, or global. A new table that is none of these
  fails the test, so someone decides.
- **People who have since gone.** Every foreign key to `users` in the
  selected rows is checked against the accounts that exist now:
  - rows that belong to that person are dropped — their membership
    (`organization_members`, and with it their `organization_member_roles`),
    their `reminder` and `push_pref` rows, their `calendar_assignee` rows —
    along with any selected row that depends on a dropped one;
  - every other reference is credited to the "Deleted user" tombstone —
    the rule account deletion already applies.
- **The slug** is kept if it is still free, else it becomes
  `<slug>-restored` (then `-restored-2`, …). The report says so.
- **One transaction, plain INSERTs.** No conflict is tolerated: the ids
  belong to a family that does not exist, so a clash means something is
  wrong, and the whole restore rolls back.
- **Photos:** the family's milestone photos come back as in §1.
- **Report:** rows per table; members rejoined and dropped; whether an
  admin remains (a family whose every admin has gone comes back with the
  console's "no admin" badge, to be fixed on its page); the slug if it
  changed; missing photos.

## 3. The console

On the Ops tab, each snapshot row gains **Deleted families**, a sheet of
the families in that snapshot that do not exist now:

- **`GET /api/admin/backups/{date}/families`** (tierSysadmin) →
  `[{id, name, slug, members, babies, deletedAt, deletedBy}]`. Counts come
  from the snapshot. `deletedAt` / `deletedBy` (the operator's name) come
  from the `family.delete` audit row for that id, when there is one — the
  console's delete is the only path that removes a family, so an operator
  can see whose mistake they are undoing.
- **`POST /api/admin/backups/{date}/families/{id}/restore`**
  (tierSysadmin) → the report. `409 FAMILY_EXISTS`, `404 NOT_FOUND`. The
  `family.restore` audit row (target the family, detail the date) is
  written **inside the restore's transaction**, so it exists exactly when
  the restore does.
- Each row has a tap-twice **Restore**, under a line: "Restore a family
  only to undo a mistake — never one deleted at its owners' request." On
  success, a toast and a link to the family's page, and the report's
  warnings (members dropped, no admin, slug changed, photos missing)
  listed in the sheet.
- The snapshot is read whole in the server process: tens of megabytes at
  most, for one operator request.

**The privacy policy** says backups are "only ever used to restore the
service after a failure". It gains: "or to undo a deletion made by
mistake — never one you asked for", in both languages.

## Testing

Test-first. Go against real Postgres; the `restore` package's tests live
in `package restore_test` (the test rig imports `internal/api`, which will
import `restore`).

- **Loader:** load order follows the foreign keys; generated columns are
  skipped; a snapshot key the table lacks is ignored; a column the
  snapshot lacks gets its default; a snapshot table that no longer exists
  is reported; chunks past 1,000 rows.
- **Round trip:** a rig database with families, babies, every log kind,
  photos, calendar, contacts, members → `RunBackup` → a fresh database →
  whole restore → the same rows (minus the nulled credentials and
  sessions); photos back in storage from the backup trees, current and
  deleted.
- **Whole restore guards:** refuses a database with a family or a real
  user; the tombstone is the one tolerated conflict; a snapshot without
  `schemaVersion` loads with a warning; `schemaVersion` is written by the
  backup.
- **Family restore:** a deleted family comes back with its rows; a family
  that exists is refused; a missing id is not found; a member whose
  account is gone is dropped with their roles, reminders and assignments,
  and their log entries are credited to the tombstone; a taken slug
  becomes `-restored`; api keys, devices and push subscriptions stay
  gone; another family's rows are untouched; a failure rolls everything
  back.
- **Guard:** every live table classified.
- **Console:** the deleted-families list (only families absent now, with
  counts and who deleted them); restore → 200 and the family's page works;
  audited in the same transaction; 409 / 404; tier gate test.
- **CLI:** argument parsing for `restore`, `restore family` and
  `set-password`; set-password reads stdin and refuses short passwords.
- **E2E:** an operator creates a family with a baby, runs the nightly
  job, deletes the family, opens the snapshot's deleted families, restores
  it, and finds it back with its baby.

## Out of scope

Rolling a live family back; restoring into a non-empty database;
restoring avatars and vaccine documents (never backed up); a per-user
restore; restoring from the console the whole database.
