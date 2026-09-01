-- Vaccines (Task 14; REF §A1 "vaccines.ts (+ files)"). vaccine_log is
-- structurally the same "id, family_id, baby_id, caretaker_id, time,
-- …kind-specific columns, notes, created_at" shape other_logs.sql's six
-- kinds share (dose_number/schedule_slot instead of e.g. medicine_log's
-- amount/unit) — see that file's header for the UpdateX CASE/set-flag
-- tri-state pattern UpdateVaccine below reuses verbatim. Free: never plan-
-- gated (only attaching a document is — see files.sql below).
--
-- Documents are hydrated separately from the log rows rather than joined
-- inline: a vaccine can have zero or several documents, and Postgres has no
-- array_agg-of-composite that sqlc turns into a clean Go type. ListVaccines
-- (many logs) uses a single batched query keyed by ANY(vaccine_log_ids);
-- GetVaccine (one log, reused by Create/Update's re-read) uses the
-- single-id form. Both order by created_at ASC, matching
-- apps/api/src/db/scoped.ts's hydrateVaccines.

-- name: ListVaccines :many
SELECT
    v."id", v."baby_id", v."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    v."time", v."name", v."dose_number", v."schedule_slot", v."notes"
FROM "vaccine_log" v
JOIN "users" u ON u."id" = v."caretaker_id"
WHERE v."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR v."baby_id" = sqlc.narg(baby_id))
ORDER BY v."time" DESC, v."id" DESC
LIMIT sqlc.arg(lim);

-- name: GetVaccine :one
SELECT
    v."id", v."baby_id", v."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    v."time", v."name", v."dose_number", v."schedule_slot", v."notes"
FROM "vaccine_log" v
JOIN "users" u ON u."id" = v."caretaker_id"
WHERE v."family_id" = $1 AND v."id" = $2;

-- name: ListVaccineDocumentsForLogs :many
-- Batched hydration for ListVaccines: every document belonging to any of
-- vaccine_log_ids, still family-scoped (defence in depth — the caller
-- already scoped the ids themselves).
SELECT "id", "vaccine_log_id", "filename", "content_type", "size"
FROM "vaccine_document"
WHERE "family_id" = sqlc.arg(family_id)
  AND "vaccine_log_id" = ANY(sqlc.slice(vaccine_log_ids))
ORDER BY "created_at" ASC;

-- name: ListVaccineDocumentsForLog :many
-- Single-log hydration for GetVaccine.
SELECT "id", "filename", "content_type", "size"
FROM "vaccine_document"
WHERE "family_id" = $1 AND "vaccine_log_id" = $2
ORDER BY "created_at" ASC;

-- name: CreateVaccine :one
INSERT INTO "vaccine_log"
    ("family_id", "baby_id", "caretaker_id", "time", "name", "dose_number", "schedule_slot", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING "id";

-- name: UpdateVaccine :execrows
UPDATE "vaccine_log"
SET
    "time" = CASE WHEN sqlc.arg(time_set)::bool THEN sqlc.narg(time_val)::timestamptz ELSE "time" END,
    "name" = CASE WHEN sqlc.arg(name_set)::bool THEN sqlc.narg(name_val)::text ELSE "name" END,
    "dose_number" = CASE WHEN sqlc.arg(dose_number_set)::bool THEN sqlc.narg(dose_number_val)::int ELSE "dose_number" END,
    "schedule_slot" = CASE WHEN sqlc.arg(schedule_slot_set)::bool THEN sqlc.narg(schedule_slot_val)::text ELSE "schedule_slot" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: VaccineObjectKeysForLog :many
-- The object-store keys behind one vaccine log's documents, read BEFORE
-- DeleteVaccine below: the DB row (and its vaccine_document children, via
-- ON DELETE CASCADE) is gone once DeleteVaccine runs, but the objects in
-- Storage are not — internal/api/vaccines.go deletes those separately using
-- the keys this query returns (mirrors apps/api's scoped.ts deleteVaccine).
SELECT "object_key"
FROM "vaccine_document"
WHERE "family_id" = $1 AND "vaccine_log_id" = $2;

-- name: DeleteVaccine :execrows
DELETE FROM "vaccine_log"
WHERE "family_id" = $1 AND "id" = $2;

-- --- vaccine_dismissal: programme slots waved away for one baby ---

-- name: ListVaccineDismissals :many
SELECT "id", "baby_id", "slot_key"
FROM "vaccine_dismissal"
WHERE "family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR "baby_id" = sqlc.narg(baby_id))
ORDER BY "created_at" ASC;

-- name: CreateVaccineDismissal :one
-- ON CONFLICT DO NOTHING makes a repeat dismissal affect zero rows instead
-- of failing on vaccine_dismissal_baby_slot's unique index; sqlc's :one
-- then reports pgx.ErrNoRows for that case, and
-- internal/api/vaccines.go's CreateVaccineDismissal falls back to
-- GetVaccineDismissalBySlot to return the row that already exists —
-- mirrors apps/api's scoped.ts createVaccineDismissal exactly.
INSERT INTO "vaccine_dismissal" ("family_id", "baby_id", "slot_key", "dismissed_by")
VALUES ($1, $2, $3, $4)
ON CONFLICT ("baby_id", "slot_key") DO NOTHING
RETURNING "id", "baby_id", "slot_key";

-- name: GetVaccineDismissalBySlot :one
SELECT "id", "baby_id", "slot_key"
FROM "vaccine_dismissal"
WHERE "family_id" = $1 AND "baby_id" = $2 AND "slot_key" = $3;

-- name: DeleteVaccineDismissal :execrows
DELETE FROM "vaccine_dismissal"
WHERE "family_id" = $1 AND "id" = $2;

-- --- vaccine_document: R2/S3-backed attachments. Uploading is disabled
-- (internal/api/files.go's DocumentUploadsEnabled = false) but these
-- queries back the reading/deleting paths that stay open regardless, plus
-- the dead-but-real upload path behind the flag. ---

-- name: CountVaccineDocuments :one
SELECT COUNT(*)::int
FROM "vaccine_document"
WHERE "family_id" = $1 AND "vaccine_log_id" = $2;

-- name: CreateVaccineDocument :one
INSERT INTO "vaccine_document"
    ("family_id", "vaccine_log_id", "object_key", "filename", "content_type", "size", "uploaded_by")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: GetVaccineDocument :one
SELECT "id", "object_key", "filename", "content_type", "size"
FROM "vaccine_document"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteVaccineDocument :one
-- RETURNING the object_key so the caller can delete the stored bytes after
-- the row (and only after — see internal/api/files.go) is gone; zero rows
-- (pgx.ErrNoRows) means "not found or not ours".
DELETE FROM "vaccine_document"
WHERE "family_id" = $1 AND "id" = $2
RETURNING "object_key";
