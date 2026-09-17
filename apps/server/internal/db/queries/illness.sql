-- Illness episodes (issue #107). daycare.sql's skeleton — family-scoped,
-- "end_time IS NULL" means still ill, one open episode per baby by 00023's
-- partial unique index — with what an illness has that a day at barnehage
-- does not: a set of symptoms, the moment of the last one, and the family's
-- own number of hours for the clock the SPA draws from those two.

-- name: ListIllnesses :many
SELECT
    i."id", i."baby_id", i."caretaker_id", i."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    i."start_time", i."end_time", i."symptoms", i."last_symptom_at", i."clear_hours", i."notes"
FROM "illness" i
JOIN "users" u ON u."id" = i."caretaker_id"
JOIN "users" lu ON lu."id" = i."logged_by_id"
WHERE i."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR i."baby_id" = sqlc.narg(baby_id))
ORDER BY i."start_time" DESC, i."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetIllness :one
SELECT
    i."id", i."baby_id", i."caretaker_id", i."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    i."start_time", i."end_time", i."symptoms", i."last_symptom_at", i."clear_hours", i."notes"
FROM "illness" i
JOIN "users" u ON u."id" = i."caretaker_id"
JOIN "users" lu ON lu."id" = i."logged_by_id"
WHERE i."family_id" = $1 AND i."id" = $2;

-- name: ActiveIllness :one
SELECT
    i."id", i."baby_id", i."caretaker_id", i."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    i."start_time", i."end_time", i."symptoms", i."last_symptom_at", i."clear_hours", i."notes"
FROM "illness" i
JOIN "users" u ON u."id" = i."caretaker_id"
JOIN "users" lu ON lu."id" = i."logged_by_id"
WHERE i."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR i."baby_id" = sqlc.narg(baby_id))
  AND i."end_time" IS NULL
ORDER BY i."start_time" DESC
LIMIT 1;

-- name: CreateIllness :one
INSERT INTO "illness" ("family_id", "baby_id", "caretaker_id", "logged_by_id", "start_time", "end_time", "symptoms", "last_symptom_at", "clear_hours", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING "id";

-- name: RecoverIllness :execrows
-- The end_time IS NULL guard makes a replayed Recovered harmless, as
-- daycare.sql's PickupDaycare does for a replayed pick-up.
UPDATE "illness"
SET "end_time" = sqlc.arg(end_time)
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id) AND "end_time" IS NULL;

-- name: UpdateIllness :execrows
UPDATE "illness"
SET
    "caretaker_id" = CASE WHEN sqlc.arg(caretaker_id_set)::bool THEN sqlc.narg(caretaker_id_val)::text ELSE "caretaker_id" END,
    "start_time" = CASE WHEN sqlc.arg(start_time_set)::bool THEN sqlc.narg(start_time_val)::timestamptz ELSE "start_time" END,
    "end_time" = CASE WHEN sqlc.arg(end_time_set)::bool THEN sqlc.narg(end_time_val)::timestamptz ELSE "end_time" END,
    "symptoms" = CASE WHEN sqlc.arg(symptoms_set)::bool THEN sqlc.arg(symptoms_val)::text[] ELSE "symptoms" END,
    "last_symptom_at" = CASE WHEN sqlc.arg(last_symptom_at_set)::bool THEN sqlc.narg(last_symptom_at_val)::timestamptz ELSE "last_symptom_at" END,
    "clear_hours" = CASE WHEN sqlc.arg(clear_hours_set)::bool THEN sqlc.narg(clear_hours_val)::integer ELSE "clear_hours" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteIllness :execrows
DELETE FROM "illness"
WHERE "family_id" = $1 AND "id" = $2;
