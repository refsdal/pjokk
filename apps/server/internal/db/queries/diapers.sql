-- Diaper logs (Task 10; REF §A1 diapers.ts — "same skeleton" as feeds.sql,
-- minus the feed-only columns). See feeds.sql's header for the UpdateDiaper
-- CASE/set-flag pattern; internal/api/feeds.go documents the handler side
-- in full, internal/api/diapers.go just points back to it.

-- name: ListDiapers :many
-- COALESCE(u.name, '') — see feeds.sql's ListFeeds for why (sqlc can't prove
-- an inner-joined column NOT NULL from a bare alias).
SELECT
    d."id", d."baby_id", d."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    d."time", d."type", d."notes"
FROM "diaper_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR d."baby_id" = sqlc.narg(baby_id))
ORDER BY d."time" DESC, d."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetDiaper :one
SELECT
    d."id", d."baby_id", d."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    d."time", d."type", d."notes"
FROM "diaper_log" d
JOIN "users" u ON u."id" = d."caretaker_id"
WHERE d."family_id" = $1 AND d."id" = $2;

-- name: CreateDiaper :one
INSERT INTO "diaper_log" ("family_id", "baby_id", "caretaker_id", "time", "type", "notes")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING "id";

-- name: UpdateDiaper :execrows
UPDATE "diaper_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "type" = CASE WHEN sqlc.arg(type_set)::bool THEN sqlc.narg(type_val)::text ELSE "type" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteDiaper :execrows
DELETE FROM "diaper_log"
WHERE "family_id" = $1 AND "id" = $2;
