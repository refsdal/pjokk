-- The six Phase 3 activity types (Task 12; REF §A1 "other-logs.ts —
-- makeLogRoutes factory"). Every kind shares one structural shape (id,
-- family_id, baby_id, caretaker_id, time, …kind-specific columns, notes,
-- created_at) and therefore one query shape: List/Get/Create/Update/Delete,
-- five queries per table, thirty in total. sqlc has no generics, so these
-- are written out mechanically rather than shared — internal/api/other_logs.go
-- is where the actual reuse lives (a small generic engine wrapping these
-- per-kind sqlc funcs; see its doc comment). See feeds.sql's header for the
-- UpdateX CASE/set-flag tri-state pattern every UpdateX query below reuses
-- verbatim, one `<column>_set`/`<column>_val` pair per clearable column.

-- --- medicine_log ---

-- name: ListMedicine :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."name", m."amount", m."unit", m."notes"
FROM "medicine_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR m."baby_id" = sqlc.narg(baby_id))
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetMedicine :one
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."name", m."amount", m."unit", m."notes"
FROM "medicine_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = $1 AND m."id" = $2;

-- name: CreateMedicine :one
INSERT INTO "medicine_log"
    ("family_id", "baby_id", "caretaker_id", "time", "name", "amount", "unit", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING "id";

-- name: UpdateMedicine :execrows
UPDATE "medicine_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "name" = CASE WHEN sqlc.arg(name_set)::bool THEN sqlc.narg(name_val)::text ELSE "name" END,
    "amount" = CASE WHEN sqlc.arg(amount_set)::bool THEN sqlc.narg(amount_val)::double precision ELSE "amount" END,
    "unit" = CASE WHEN sqlc.arg(unit_set)::bool THEN sqlc.narg(unit_val)::text ELSE "unit" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteMedicine :execrows
DELETE FROM "medicine_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- bath_log ---

-- name: ListBaths :many
SELECT
    b."id", b."baby_id", b."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    b."time", b."notes"
FROM "bath_log" b
JOIN "users" u ON u."id" = b."caretaker_id"
WHERE b."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR b."baby_id" = sqlc.narg(baby_id))
ORDER BY b."time" DESC, b."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetBath :one
SELECT
    b."id", b."baby_id", b."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    b."time", b."notes"
FROM "bath_log" b
JOIN "users" u ON u."id" = b."caretaker_id"
WHERE b."family_id" = $1 AND b."id" = $2;

-- name: CreateBath :one
INSERT INTO "bath_log" ("family_id", "baby_id", "caretaker_id", "time", "notes")
VALUES ($1, $2, $3, $4, $5)
RETURNING "id";

-- name: UpdateBath :execrows
UPDATE "bath_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteBath :execrows
DELETE FROM "bath_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- note_log ---

-- name: ListNotes :many
SELECT
    n."id", n."baby_id", n."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    n."time", n."content", n."notes"
FROM "note_log" n
JOIN "users" u ON u."id" = n."caretaker_id"
WHERE n."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR n."baby_id" = sqlc.narg(baby_id))
ORDER BY n."time" DESC, n."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetNote :one
SELECT
    n."id", n."baby_id", n."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    n."time", n."content", n."notes"
FROM "note_log" n
JOIN "users" u ON u."id" = n."caretaker_id"
WHERE n."family_id" = $1 AND n."id" = $2;

-- name: CreateNote :one
INSERT INTO "note_log" ("family_id", "baby_id", "caretaker_id", "time", "content", "notes")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING "id";

-- name: UpdateNote :execrows
UPDATE "note_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "content" = CASE WHEN sqlc.arg(content_set)::bool THEN sqlc.narg(content_val)::text ELSE "content" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteNote :execrows
DELETE FROM "note_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- milestone_log ---

-- name: ListMilestones :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."title", m."notes"
FROM "milestone_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR m."baby_id" = sqlc.narg(baby_id))
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetMilestone :one
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."title", m."notes"
FROM "milestone_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = $1 AND m."id" = $2;

-- name: CreateMilestone :one
INSERT INTO "milestone_log" ("family_id", "baby_id", "caretaker_id", "time", "title", "notes")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING "id";

-- name: UpdateMilestone :execrows
UPDATE "milestone_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "title" = CASE WHEN sqlc.arg(title_set)::bool THEN sqlc.narg(title_val)::text ELSE "title" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteMilestone :execrows
DELETE FROM "milestone_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- measurement_log ---

-- name: ListMeasurements :many
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."type", m."value", m."notes"
FROM "measurement_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR m."baby_id" = sqlc.narg(baby_id))
ORDER BY m."time" DESC, m."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetMeasurement :one
SELECT
    m."id", m."baby_id", m."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    m."time", m."type", m."value", m."notes"
FROM "measurement_log" m
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = $1 AND m."id" = $2;

-- name: CreateMeasurement :one
INSERT INTO "measurement_log" ("family_id", "baby_id", "caretaker_id", "time", "type", "value", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: UpdateMeasurement :execrows
UPDATE "measurement_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "type" = CASE WHEN sqlc.arg(type_set)::bool THEN sqlc.narg(type_val)::text ELSE "type" END,
    "value" = CASE WHEN sqlc.arg(value_set)::bool THEN sqlc.narg(value_val)::double precision ELSE "value" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteMeasurement :execrows
DELETE FROM "measurement_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- pump_log ---

-- name: ListPumps :many
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."time", p."side", p."amount_ml", p."duration_min", p."notes"
FROM "pump_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR p."baby_id" = sqlc.narg(baby_id))
ORDER BY p."time" DESC, p."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetPump :one
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."time", p."side", p."amount_ml", p."duration_min", p."notes"
FROM "pump_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = $1 AND p."id" = $2;

-- name: CreatePump :one
INSERT INTO "pump_log"
    ("family_id", "baby_id", "caretaker_id", "time", "side", "amount_ml", "duration_min", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING "id";

-- name: UpdatePump :execrows
UPDATE "pump_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "side" = CASE WHEN sqlc.arg(side_set)::bool THEN sqlc.narg(side_val)::text ELSE "side" END,
    "amount_ml" = CASE WHEN sqlc.arg(amount_ml_set)::bool THEN sqlc.narg(amount_ml_val)::integer ELSE "amount_ml" END,
    "duration_min" = CASE WHEN sqlc.arg(duration_min_set)::bool THEN sqlc.narg(duration_min_val)::integer ELSE "duration_min" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeletePump :execrows
DELETE FROM "pump_log"
WHERE "family_id" = $1 AND "id" = $2;
