-- Feed logs (Task 10; REF §A1 feeds.ts). Every query is family-scoped
-- (CLAUDE.md's tenancy discipline).
--
-- UpdateFeed is the PATCH tri-state pattern internal/api/feeds.go documents
-- in full: one `<column>_set` bool + one nullable `<column>_val` per
-- clearable column, combined with `SET col = CASE WHEN $set THEN $val ELSE
-- col END` so a single statement applies an arbitrary subset of
-- sets/clears/leaves without a query per combination. `_set = false` means
-- "leave alone" regardless of what `_val` carries; `_set = true` with a NULL
-- `_val` means "clear"; `_set = true` with a non-NULL `_val` means "set".

-- name: ListFeeds :many
-- COALESCE(u.name, '') rather than a bare u."name": sqlc's static analysis
-- can't prove an inner-joined column NOT NULL, so a bare alias would come
-- back as a *string; the family.sql ListFamilyMembers query uses the same
-- trick for the same reason.
SELECT
    f."id", f."baby_id", f."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    f."time", f."type", f."amount_ml", f."side", f."duration_min",
    f."left_min", f."right_min", f."notes"
FROM "feed_log" f
JOIN "users" u ON u."id" = f."caretaker_id"
WHERE f."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR f."baby_id" = sqlc.narg(baby_id))
ORDER BY f."time" DESC, f."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetFeed :one
SELECT
    f."id", f."baby_id", f."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    f."time", f."type", f."amount_ml", f."side", f."duration_min",
    f."left_min", f."right_min", f."notes"
FROM "feed_log" f
JOIN "users" u ON u."id" = f."caretaker_id"
WHERE f."family_id" = $1 AND f."id" = $2;

-- name: CreateFeed :one
INSERT INTO "feed_log"
    ("family_id", "baby_id", "caretaker_id", "time", "type", "amount_ml",
     "side", "duration_min", "left_min", "right_min", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING "id";

-- name: UpdateFeed :execrows
UPDATE "feed_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "type" = CASE WHEN sqlc.arg(type_set)::bool THEN sqlc.narg(type_val)::text ELSE "type" END,
    "amount_ml" = CASE WHEN sqlc.arg(amount_ml_set)::bool THEN sqlc.narg(amount_ml_val)::integer ELSE "amount_ml" END,
    "side" = CASE WHEN sqlc.arg(side_set)::bool THEN sqlc.narg(side_val)::text ELSE "side" END,
    "duration_min" = CASE WHEN sqlc.arg(duration_min_set)::bool THEN sqlc.narg(duration_min_val)::integer ELSE "duration_min" END,
    "left_min" = CASE WHEN sqlc.arg(left_min_set)::bool THEN sqlc.narg(left_min_val)::integer ELSE "left_min" END,
    "right_min" = CASE WHEN sqlc.arg(right_min_set)::bool THEN sqlc.narg(right_min_val)::integer ELSE "right_min" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteFeed :execrows
DELETE FROM "feed_log"
WHERE "family_id" = $1 AND "id" = $2;
