-- Custom sleep-location chips (Task 11; REF §A1 sleep-locations.ts). No
-- unique constraint on (family_id, name) at the database — the duplicate
-- and 20-cap checks are application-level in internal/api/sleep_locations.go
-- (a pre-check-then-insert race, same as apps/api/src/routes/
-- sleep-locations.ts; unlike sleep_log's active session there is no partial
-- unique index backing this one).

-- name: ListSleepLocations :many
SELECT "id", "name"
FROM "sleep_location"
WHERE "family_id" = $1
ORDER BY "created_at";

-- name: CreateSleepLocation :one
INSERT INTO "sleep_location" ("family_id", "name")
VALUES ($1, $2)
RETURNING "id", "name";

-- name: DeleteSleepLocation :execrows
DELETE FROM "sleep_location"
WHERE "family_id" = $1 AND "id" = $2;
