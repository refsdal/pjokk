-- The family's medicine catalogue (issue #49; 00011_medicine.sql). A
-- bespoke family entity like contacts, not logCrud: no time, no caretaker.
-- Every query is family-scoped. "Catalogue" in the names keeps them apart
-- from other_logs.sql's ListMedicine/GetMedicine, which are the DOSE log.
--
-- UpdateCatalogueMedicine is the PATCH tri-state pattern queries/feeds.sql
-- documents in full.

-- name: ListCatalogueMedicines :many
-- last_dose_at is the newest dose linked to the entry, for the sheet's
-- "next dose OK from" — for one baby when baby_id is given, else for the
-- family. Archived entries sort last so the chips can stop at the first.
SELECT
    m."id", m."name", m."default_amount", m."unit", m."min_interval_min",
    m."is_supplement", m."archived_at",
    (
        SELECT MAX(l."time") FROM "medicine_log" l
        WHERE l."medicine_id" = m."id"
          AND (sqlc.narg(baby_id)::text IS NULL OR l."baby_id" = sqlc.narg(baby_id))
    )::timestamptz AS last_dose_at
FROM "medicine" m
WHERE m."family_id" = sqlc.arg(family_id)
ORDER BY (m."archived_at" IS NOT NULL), lower(m."name"), m."id";

-- name: GetCatalogueMedicine :one
SELECT
    m."id", m."name", m."default_amount", m."unit", m."min_interval_min",
    m."is_supplement", m."archived_at",
    (SELECT MAX(l."time") FROM "medicine_log" l WHERE l."medicine_id" = m."id")::timestamptz AS last_dose_at
FROM "medicine" m
WHERE m."family_id" = $1 AND m."id" = $2;

-- name: CreateCatalogueMedicine :one
INSERT INTO "medicine"
    ("family_id", "name", "default_amount", "unit", "min_interval_min", "is_supplement")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING "id";

-- name: UpdateCatalogueMedicine :execrows
UPDATE "medicine"
SET
    "name" = CASE WHEN sqlc.arg(name_set)::bool THEN sqlc.narg(name_val)::text ELSE "name" END,
    "default_amount" = CASE WHEN sqlc.arg(default_amount_set)::bool THEN sqlc.narg(default_amount_val)::double precision ELSE "default_amount" END,
    "unit" = CASE WHEN sqlc.arg(unit_set)::bool THEN sqlc.narg(unit_val)::text ELSE "unit" END,
    "min_interval_min" = CASE WHEN sqlc.arg(min_interval_min_set)::bool THEN sqlc.narg(min_interval_min_val)::integer ELSE "min_interval_min" END,
    "is_supplement" = CASE WHEN sqlc.arg(is_supplement_set)::bool THEN sqlc.narg(is_supplement_val)::boolean ELSE "is_supplement" END,
    "archived_at" = CASE WHEN sqlc.arg(archived_set)::bool THEN sqlc.narg(archived_at_val)::timestamptz ELSE "archived_at" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteCatalogueMedicine :execrows
-- Doses keep their name: medicine_log.medicine_id is ON DELETE SET NULL.
DELETE FROM "medicine"
WHERE "family_id" = $1 AND "id" = $2;
