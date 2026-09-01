-- Contacts (Task 16; REF §A1 contacts.ts). Free — no plan gate on this
-- port (the TS predecessor soft-locked creation behind premium; that gate
-- is removed here, see internal/api/contacts.go's package doc comment).
-- Babies attach via contact_baby; zero rows means the contact belongs to
-- the whole family. Hydration (attaching babies to a row) is a separate
-- batched query, same shape queries/vaccines.sql's document hydration
-- uses — see ContactBabiesForContacts below.
--
-- UpdateContact is the PATCH tri-state pattern queries/feeds.sql
-- documents in full: one `<column>_set` bool + one nullable `<column>_val`
-- per clearable column.

-- name: ListContacts :many
SELECT "id", "name", "role", "icon", "phone", "email", "website", "notes"
FROM "contact"
WHERE "family_id" = $1
ORDER BY "name", "id";

-- name: GetContact :one
SELECT "id", "name", "role", "icon", "phone", "email", "website", "notes"
FROM "contact"
WHERE "family_id" = $1 AND "id" = $2;

-- name: CreateContact :one
INSERT INTO "contact"
    ("family_id", "name", "role", "icon", "phone", "email", "website", "notes")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING "id";

-- name: UpdateContact :execrows
UPDATE "contact"
SET
    "name" = CASE WHEN sqlc.arg(name_set)::bool THEN sqlc.narg(name_val)::text ELSE "name" END,
    "role" = CASE WHEN sqlc.arg(role_set)::bool THEN sqlc.narg(role_val)::text ELSE "role" END,
    "icon" = CASE WHEN sqlc.arg(icon_set)::bool THEN sqlc.narg(icon_val)::text ELSE "icon" END,
    "phone" = CASE WHEN sqlc.arg(phone_set)::bool THEN sqlc.narg(phone_val)::text ELSE "phone" END,
    "email" = CASE WHEN sqlc.arg(email_set)::bool THEN sqlc.narg(email_val)::text ELSE "email" END,
    "website" = CASE WHEN sqlc.arg(website_set)::bool THEN sqlc.narg(website_val)::text ELSE "website" END,
    "notes" = CASE WHEN sqlc.arg(notes_set)::bool THEN sqlc.narg(notes_val)::text ELSE "notes" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteContact :execrows
DELETE FROM "contact"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteContactBabies :exec
-- Link-set replacement's clear half — see internal/api/contacts.go's
-- UpdateContact.
DELETE FROM "contact_baby" WHERE "contact_id" = $1;

-- name: CreateContactBaby :exec
INSERT INTO "contact_baby" ("contact_id", "baby_id") VALUES ($1, $2);

-- name: ContactBabiesForContacts :many
-- Hydration for ListContacts (many contacts) — one batched query keyed by
-- ANY(contact_ids), grouped client-side in internal/api/contacts.go. See
-- queries/vaccines.sql's ListVaccineDocumentsForLogs for the same shape.
SELECT cb."contact_id", b."id", b."name"
FROM "contact_baby" cb
JOIN "baby" b ON b."id" = cb."baby_id"
WHERE cb."contact_id" = ANY(sqlc.slice(contact_ids))
ORDER BY b."name";

-- name: ContactBabiesForContact :many
-- Hydration for GetContact/CreateContact/UpdateContact (one contact).
SELECT b."id", b."name"
FROM "contact_baby" cb
JOIN "baby" b ON b."id" = cb."baby_id"
WHERE cb."contact_id" = $1
ORDER BY b."name";
