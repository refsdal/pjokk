-- Sleep logs (Task 11; REF §A1 sleep.ts). Same family-scoped skeleton as
-- feeds.sql/diapers.sql (see feeds.sql's header for the UpdateSleep
-- CASE/set-flag pattern) plus the active-session lifecycle: "end_time IS
-- NULL" means a session is running, and 00001_init.sql's partial unique
-- index "sleep_one_active_per_baby" ON sleep_log(baby_id) WHERE end_time IS
-- NULL enforces "one active session per baby" at the database, not just in
-- application code — CreateSleep and UpdateSleep (when it clears end_time,
-- reopening a session) both rely on internal/api/sleep.go catching a 23505
-- from that index and turning it into 409 ALREADY_ACTIVE.

-- name: ListSleeps :many
-- COALESCE(u.name, '') — see feeds.sql's ListFeeds for why (sqlc can't prove
-- an inner-joined column NOT NULL from a bare alias).
SELECT
    s."id", s."baby_id", s."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    s."start_time", s."end_time", s."location", s."notes"
FROM "sleep_log" s
JOIN "users" u ON u."id" = s."caretaker_id"
WHERE s."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR s."baby_id" = sqlc.narg(baby_id))
ORDER BY s."start_time" DESC, s."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetSleep :one
SELECT
    s."id", s."baby_id", s."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    s."start_time", s."end_time", s."location", s."notes"
FROM "sleep_log" s
JOIN "users" u ON u."id" = s."caretaker_id"
WHERE s."family_id" = $1 AND s."id" = $2;

-- name: ActiveSleep :one
-- The active session (end_time IS NULL) for a baby, if any. babyId is
-- optional (as in apps/api's scoped.ts activeSleep): without one this
-- returns whichever active session across the family started most
-- recently, mirroring the TS behaviour exactly rather than restricting to
-- one baby.
SELECT
    s."id", s."baby_id", s."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    s."start_time", s."end_time", s."location", s."notes"
FROM "sleep_log" s
JOIN "users" u ON u."id" = s."caretaker_id"
WHERE s."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR s."baby_id" = sqlc.narg(baby_id))
  AND s."end_time" IS NULL
ORDER BY s."start_time" DESC
LIMIT 1;

-- name: CreateSleep :one
INSERT INTO "sleep_log" ("family_id", "baby_id", "caretaker_id", "start_time", "end_time", "location", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: WakeSleep :execrows
-- The end_time IS NULL guard makes double-wake harmless: the second call
-- affects zero rows rather than clobbering the endTime a first call already
-- set (see internal/api/sleep.go's WakeSleep, which turns 0 rows into a 404
-- rather than a silent no-op).
UPDATE "sleep_log"
SET "end_time" = $3
WHERE "family_id" = $1 AND "id" = $2 AND "end_time" IS NULL;

-- name: UpdateSleep :execrows
UPDATE "sleep_log"
SET
    "start_time" = CASE WHEN sqlc.arg(start_time_set)::bool THEN sqlc.narg(start_time_val)::timestamptz ELSE "start_time" END,
    "end_time" = CASE WHEN sqlc.arg(end_time_set)::bool THEN sqlc.narg(end_time_val)::timestamptz ELSE "end_time" END,
    "location" = CASE WHEN sqlc.arg(location_set)::bool THEN sqlc.narg(location_val)::text ELSE "location" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteSleep :execrows
DELETE FROM "sleep_log"
WHERE "family_id" = $1 AND "id" = $2;
