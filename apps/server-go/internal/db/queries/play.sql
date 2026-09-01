-- Play logs (Task 13; REF §A1 play.ts). Structurally a sleep_log clone: same
-- family-scoped skeleton as feeds.sql/diapers.sql (see feeds.sql's header
-- for the UpdateFeed CASE/set-flag pattern), same active-session lifecycle
-- as sleep.sql (see that file's header in full — "end_time IS NULL" means a
-- session is running, and 00001_init.sql's partial unique index
-- "play_one_active_per_baby" ON play_log(baby_id) WHERE end_time IS NULL
-- enforces "one running session per baby" at the database, not just in
-- application code) plus one column sleep_log doesn't have: "type"
-- (tummy/walk/play), the play equivalent of feed_log's "type".
--
-- ActivePlay below replaces queries/summary.sql's now-removed GetActivePlay
-- — that query existed only because this file didn't (see summary.sql's
-- header); GetSummary reads ActivePlay/serActivePlayRow from here now, the
-- same way it already reuses sleep.sql's ActiveSleep instead of duplicating
-- it.

-- name: ListPlays :many
-- COALESCE(u.name, '') — see feeds.sql's ListFeeds for why (sqlc can't prove
-- an inner-joined column NOT NULL from a bare alias).
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."type", p."start_time", p."end_time", p."notes"
FROM "play_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR p."baby_id" = sqlc.narg(baby_id))
ORDER BY p."start_time" DESC, p."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetPlay :one
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."type", p."start_time", p."end_time", p."notes"
FROM "play_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = $1 AND p."id" = $2;

-- name: ActivePlay :one
-- The running session (end_time IS NULL) for a baby, if any. babyId is
-- optional (as in apps/api's scoped.ts activePlay): without one this
-- returns whichever running session across the family started most
-- recently, mirroring sleep.sql's ActiveSleep exactly.
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."type", p."start_time", p."end_time", p."notes"
FROM "play_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR p."baby_id" = sqlc.narg(baby_id))
  AND p."end_time" IS NULL
ORDER BY p."start_time" DESC
LIMIT 1;

-- name: CreatePlay :one
INSERT INTO "play_log" ("family_id", "baby_id", "caretaker_id", "type", "start_time", "end_time", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: StopPlay :execrows
-- The end_time IS NULL guard makes a replayed stop harmless: the second
-- call affects zero rows rather than clobbering the endTime a first call
-- already set (see internal/api/play.go's StopPlay, which turns 0 rows into
-- a 404 rather than a silent no-op) — mirrors sleep.sql's WakeSleep.
UPDATE "play_log"
SET "end_time" = $3
WHERE "family_id" = $1 AND "id" = $2 AND "end_time" IS NULL;

-- name: UpdatePlay :execrows
UPDATE "play_log"
SET
    "type" = CASE WHEN sqlc.arg(type_set)::bool THEN sqlc.narg(type_val)::text ELSE "type" END,
    "start_time" = CASE WHEN sqlc.arg(start_time_set)::bool THEN sqlc.narg(start_time_val)::timestamptz ELSE "start_time" END,
    "end_time" = CASE WHEN sqlc.arg(end_time_set)::bool THEN sqlc.narg(end_time_val)::timestamptz ELSE "end_time" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeletePlay :execrows
DELETE FROM "play_log"
WHERE "family_id" = $1 AND "id" = $2;
