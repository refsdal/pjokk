-- Merged-timeline pagination (Task 15; REF §A1 timeline.ts). One "Page"
-- query per source, all eleven shaped identically: family+baby scoped
-- (baby_id is REQUIRED here, unlike ListFeeds/ListDiapers/… — the
-- /api/timeline route always has a babyId), an optional keyset cursor via
-- ROW COMPARISON "(t, id) < (cursor_t, cursor_id)" — never two separate
-- "t < $x OR (t = $x AND id < $y)" clauses, which is what makes
-- same-timestamp pagination lossless (defects.test.ts's "never drops
-- entries sharing the page-boundary timestamp" is the regression this
-- guards) — ordered (t DESC, id DESC) to match internal/api/timeline.go's
-- merge sort exactly (the keyset cursor is only correct if the SQL order and
-- the merge order agree), and capped at sqlc.arg(lim).
--
-- The cursor args are nullable (sqlc.narg): when the caller sent no ?before,
-- both cursor_time and cursor_id are SQL NULL, the "IS NULL" branch of the
-- OR is true, and the row-comparison clause never runs — i.e. no extra
-- filtering, exactly the brief's "no cursor: no row-comparison clause".
--
-- Sleep and play sort by start_time (see sleep.sql's ActiveSleep /
-- play.sql's ActivePlay for why — both are session tables where the natural
-- timeline position is when the session STARTED, not the row's other
-- timestamp); every other source sorts by time.

-- name: ListFeedsPage :many
SELECT
    f."id", f."baby_id", f."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    f."time", f."type", f."amount_ml", f."side", f."duration_min",
    f."left_min", f."right_min", f."notes"
FROM "feed_log" f
JOIN "users" u ON u."id" = f."caretaker_id"
WHERE f."family_id" = sqlc.arg(family_id)
  AND f."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (f."time", f."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY f."time" DESC, f."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListDiapersPage :many
SELECT
    d."id", d."baby_id", d."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    d."time", d."type", d."notes"
FROM "diaper_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
  AND d."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (d."time", d."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY d."time" DESC, d."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListSleepsPage :many
SELECT
    s."id", s."baby_id", s."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    s."start_time", s."end_time", s."location", s."notes"
FROM "sleep_log" s
JOIN "users" u ON u."id" = s."caretaker_id"
WHERE s."family_id" = sqlc.arg(family_id)
  AND s."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (s."start_time", s."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY s."start_time" DESC, s."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListMedicinePage :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."name", m."amount", m."unit", m."notes"
FROM "medicine_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND m."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (m."time", m."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListBathsPage :many
SELECT
    b."id", b."baby_id", b."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    b."time", b."notes"
FROM "bath_log" b
JOIN "users" u ON u."id" = b."caretaker_id"
WHERE b."family_id" = sqlc.arg(family_id)
  AND b."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (b."time", b."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY b."time" DESC, b."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListNotesPage :many
SELECT
    n."id", n."baby_id", n."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    n."time", n."content", n."notes"
FROM "note_log" n
JOIN "users" u ON u."id" = n."caretaker_id"
WHERE n."family_id" = sqlc.arg(family_id)
  AND n."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (n."time", n."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY n."time" DESC, n."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListMilestonesPage :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."title", m."notes"
FROM "milestone_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND m."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (m."time", m."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListMeasurementsPage :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."type", m."value", m."notes"
FROM "measurement_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND m."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (m."time", m."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListPumpsPage :many
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."time", p."side", p."amount_ml", p."duration_min", p."notes"
FROM "pump_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND p."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (p."time", p."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY p."time" DESC, p."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListPlaysPage :many
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."type", p."start_time", p."end_time", p."notes"
FROM "play_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND p."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (p."start_time", p."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY p."start_time" DESC, p."id" DESC
LIMIT sqlc.arg(lim);

-- name: ListVaccinesPage :many
SELECT
    v."id", v."baby_id", v."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    v."time", v."name", v."dose_number", v."schedule_slot", v."notes"
FROM "vaccine_log" v
JOIN "users" u ON u."id" = v."caretaker_id"
WHERE v."family_id" = sqlc.arg(family_id)
  AND v."baby_id" = sqlc.arg(baby_id)
  AND (
    sqlc.narg(cursor_time)::timestamptz IS NULL
    OR (v."time", v."id") < (sqlc.narg(cursor_time)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY v."time" DESC, v."id" DESC
LIMIT sqlc.arg(lim);
