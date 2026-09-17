-- Days at barnehage (issue #105). Structurally play.sql, which is
-- structurally sleep.sql: the same family-scoped skeleton, the same
-- active-session lifecycle ("end_time IS NULL" means she is there now, and
-- 00020's partial unique index "daycare_one_active_per_baby" enforces one
-- running session per baby at the database). What this table has that
-- those do not is a second person: pickup_caretaker_id, LEFT JOINed
-- because it is NULL while the session runs and on a finished row whose
-- pick-up person nobody recorded.

-- name: ListDaycares :many
SELECT
    d."id", d."baby_id", d."caretaker_id", d."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    d."pickup_caretaker_id", pu."display_name" AS pickup_caretaker_name,
    d."start_time", d."end_time", d."notes", d."mood"
FROM "daycare_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
JOIN "users" lu ON lu."id" = d."logged_by_id"
LEFT JOIN "users" pu ON pu."id" = d."pickup_caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR d."baby_id" = sqlc.narg(baby_id))
ORDER BY d."start_time" DESC, d."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetDaycare :one
SELECT
    d."id", d."baby_id", d."caretaker_id", d."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    d."pickup_caretaker_id", pu."display_name" AS pickup_caretaker_name,
    d."start_time", d."end_time", d."notes", d."mood"
FROM "daycare_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
JOIN "users" lu ON lu."id" = d."logged_by_id"
LEFT JOIN "users" pu ON pu."id" = d."pickup_caretaker_id"
WHERE d."family_id" = $1 AND d."id" = $2;

-- name: ActiveDaycare :one
-- The running session for a baby, if any; without a baby, the family's most
-- recently started one — sleep.sql's ActiveSleep exactly.
SELECT
    d."id", d."baby_id", d."caretaker_id", d."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    d."pickup_caretaker_id", pu."display_name" AS pickup_caretaker_name,
    d."start_time", d."end_time", d."notes", d."mood"
FROM "daycare_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
JOIN "users" lu ON lu."id" = d."logged_by_id"
LEFT JOIN "users" pu ON pu."id" = d."pickup_caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR d."baby_id" = sqlc.narg(baby_id))
  AND d."end_time" IS NULL
ORDER BY d."start_time" DESC
LIMIT 1;

-- name: CreateDaycare :one
INSERT INTO "daycare_log" ("family_id", "baby_id", "caretaker_id", "logged_by_id", "pickup_caretaker_id", "start_time", "end_time", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING "id";

-- name: PickupDaycare :execrows
-- The end_time IS NULL guard makes a replayed pick-up harmless: the second
-- call affects zero rows rather than moving the end a first call set, or
-- renaming who picked up (play.sql's StopPlay, sleep.sql's WakeSleep).
UPDATE "daycare_log"
SET "end_time" = sqlc.arg(end_time), "pickup_caretaker_id" = sqlc.arg(pickup_caretaker_id)
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id) AND "end_time" IS NULL;

-- name: UpdateDaycare :execrows
UPDATE "daycare_log"
SET
    "caretaker_id" = CASE WHEN sqlc.arg(caretaker_id_set)::bool THEN sqlc.narg(caretaker_id_val)::text ELSE "caretaker_id" END,
    "pickup_caretaker_id" = CASE WHEN sqlc.arg(pickup_caretaker_id_set)::bool THEN sqlc.narg(pickup_caretaker_id_val)::text ELSE "pickup_caretaker_id" END,
    "start_time" = CASE WHEN sqlc.arg(start_time_set)::bool THEN sqlc.narg(start_time_val)::timestamptz ELSE "start_time" END,
    "end_time" = CASE WHEN sqlc.arg(end_time_set)::bool THEN sqlc.narg(end_time_val)::timestamptz ELSE "end_time" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteDaycare :execrows
DELETE FROM "daycare_log"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DaycareHold :one
-- What the reminder job needs to know about barnehage (internal/jobs/
-- reminders.go): is the baby there now, and when was she last picked up.
-- A reminder with no baby asks about the whole family — "any baby there",
-- "the latest pick-up". An aggregate, so it always answers one row.
SELECT
    COALESCE(bool_or(d."end_time" IS NULL), false)::bool AS there_now,
    MAX(d."end_time")::timestamptz AS last_pickup
FROM "daycare_log" d
WHERE d."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR d."baby_id" = sqlc.narg(baby_id));

-- name: HandoverDue :one
-- The newest day that ended within the window and has no handover yet: no
-- mood and no linked row (issue #106). Backs Summary.handoverDue, Home's
-- "How was the day?" card.
SELECT
    d."id", d."baby_id", d."caretaker_id", d."logged_by_id", COALESCE(u."display_name", '') AS caretaker_name, COALESCE(lu."display_name", '') AS logged_by_name,
    d."pickup_caretaker_id", pu."display_name" AS pickup_caretaker_name,
    d."start_time", d."end_time", d."notes", d."mood"
FROM "daycare_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
JOIN "users" lu ON lu."id" = d."logged_by_id"
LEFT JOIN "users" pu ON pu."id" = d."pickup_caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
  AND d."baby_id" = sqlc.arg(baby_id)
  AND d."end_time" IS NOT NULL
  AND d."end_time" > sqlc.arg(since)::timestamptz
  AND d."mood" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "sleep_log" x WHERE x."daycare_id" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "feed_log" x WHERE x."daycare_id" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "diaper_log" x WHERE x."daycare_id" = d."id")
ORDER BY d."end_time" DESC
LIMIT 1;

-- The handover's rows. Every statement is family-scoped as well as
-- day-scoped: the day's id alone is never the whole key.

-- name: SetDaycareMood :exec
UPDATE "daycare_log" SET "mood" = sqlc.narg(mood)
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: ListHandoverNaps :many
SELECT "start_time", "end_time" FROM "sleep_log"
WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id) AND "end_time" IS NOT NULL
ORDER BY "start_time", "id";

-- name: ListHandoverMeals :many
SELECT "time", "appetite", "food" FROM "feed_log"
WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id)
ORDER BY "time", "id";

-- name: CountHandoverDiapers :one
-- 'both' counts as dirty: the sheet has two steppers, and a row a parent
-- later edited to "both" is still one nappy that was not merely wet.
SELECT
    COUNT(*) FILTER (WHERE "type" = 'wet')::int AS wet,
    COUNT(*) FILTER (WHERE "type" IN ('dirty', 'both'))::int AS dirty
FROM "diaper_log"
WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id);

-- name: DeleteHandoverSleeps :exec
DELETE FROM "sleep_log" WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id);

-- name: DeleteHandoverFeeds :exec
DELETE FROM "feed_log" WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id);

-- name: DeleteHandoverDiapers :exec
DELETE FROM "diaper_log" WHERE "family_id" = sqlc.arg(family_id) AND "daycare_id" = sqlc.arg(daycare_id);

-- name: CreateHandoverNap :exec
INSERT INTO "sleep_log" ("family_id", "baby_id", "caretaker_id", "logged_by_id", "daycare_id", "start_time", "end_time", "location", "type")
VALUES (sqlc.arg(family_id), sqlc.arg(baby_id), sqlc.arg(user_id), sqlc.arg(user_id), sqlc.arg(daycare_id), sqlc.arg(start_time), sqlc.arg(end_time), sqlc.arg(location), 'nap');

-- name: CreateHandoverMeal :exec
INSERT INTO "feed_log" ("family_id", "baby_id", "caretaker_id", "logged_by_id", "daycare_id", "time", "type", "appetite", "food")
VALUES (sqlc.arg(family_id), sqlc.arg(baby_id), sqlc.arg(user_id), sqlc.arg(user_id), sqlc.arg(daycare_id), sqlc.arg(time), 'solids', sqlc.narg(appetite), sqlc.narg(food));

-- name: CreateHandoverDiaper :exec
INSERT INTO "diaper_log" ("family_id", "baby_id", "caretaker_id", "logged_by_id", "daycare_id", "time", "type")
VALUES (sqlc.arg(family_id), sqlc.arg(baby_id), sqlc.arg(user_id), sqlc.arg(user_id), sqlc.arg(daycare_id), sqlc.arg(time), sqlc.arg(type));
