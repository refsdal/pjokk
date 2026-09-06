-- Help requests (docs/superpowers/specs/2026-09-06-help-request-design.md).
-- Backs internal/api/help.go, GET /api/summary's openHelp
-- (internal/api/summary.go) and the nightly purge (internal/jobs/help.go).
-- Every query on help_request is family-scoped in the WHERE clause.
--
-- The two SELECTs (GetHelpRequest, NewestHelpRequest) project the SAME
-- column list so internal/api/help.go can serialise both row types through
-- one function — the play.sql / play.go arrangement.
--
-- acknowledged_by_name is COALESCE'd to '' rather than left nullable: the
-- LEFT JOIN makes it NULL both when nobody has acknowledged AND when the
-- acknowledger has no display name, and only the handler knows which (it
-- checks acknowledged_at). users.name is nullable, hence the COALESCE on
-- every name, as in feeds.sql's ListFeeds.

-- name: CreateHelpRequest :one
-- created_at is passed in, not defaulted, so the handler's Deps.Now clock
-- (and therefore testrig.SetNow) governs the two-hour window.
INSERT INTO "help_request" ("family_id", "from_user_id", "to_user_id", "message", "created_at")
VALUES ($1, $2, $3, $4, $5)
RETURNING "id";

-- name: GetHelpRequest :one
SELECT
    h."id", h."family_id",
    h."from_user_id", COALESCE(f."name", '')::text AS from_name,
    h."to_user_id", COALESCE(t."name", '')::text AS to_name,
    h."message", h."created_at", h."acknowledged_at", h."acknowledged_by",
    COALESCE(a."name", '')::text AS acknowledged_by_name
FROM "help_request" h
JOIN "users" f ON f."id" = h."from_user_id"
JOIN "users" t ON t."id" = h."to_user_id"
LEFT JOIN "users" a ON a."id" = h."acknowledged_by"
WHERE h."family_id" = $1 AND h."id" = $2;

-- name: NewestHelpRequest :one
-- The family's newest request created after `since` (now minus the window),
-- whatever its state. Older rows are simply not returned — that IS the
-- expiry mechanism.
SELECT
    h."id", h."family_id",
    h."from_user_id", COALESCE(f."name", '')::text AS from_name,
    h."to_user_id", COALESCE(t."name", '')::text AS to_name,
    h."message", h."created_at", h."acknowledged_at", h."acknowledged_by",
    COALESCE(a."name", '')::text AS acknowledged_by_name
FROM "help_request" h
JOIN "users" f ON f."id" = h."from_user_id"
JOIN "users" t ON t."id" = h."to_user_id"
LEFT JOIN "users" a ON a."id" = h."acknowledged_by"
WHERE h."family_id" = sqlc.arg(family_id)
  AND h."created_at" > sqlc.arg(since)::timestamptz
ORDER BY h."created_at" DESC, h."id" DESC
LIMIT 1;

-- name: AcknowledgeHelpRequest :execrows
-- The acknowledged_at IS NULL guard makes a second acknowledge affect zero
-- rows instead of overwriting who answered first — the handler treats zero
-- rows as "already acknowledged, return it unchanged, send nothing".
UPDATE "help_request"
SET "acknowledged_at" = sqlc.arg(acknowledged_at), "acknowledged_by" = sqlc.arg(acknowledged_by)
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id) AND "acknowledged_at" IS NULL;

-- name: DeleteHelpRequest :execrows
DELETE FROM "help_request"
WHERE "family_id" = $1 AND "id" = $2;

-- name: PurgeOldHelpRequests :execrows
-- Nightly housekeeping only; deliberately NOT family-scoped, like
-- jobs.sql's ListOrphanUsers — it runs unattended across every family.
DELETE FROM "help_request"
WHERE "created_at" < $1;

-- name: GetMembershipUser :one
-- Resolves the memberId a client sends (the organization_members row id
-- GET /api/family/members exposes) to the user a push is keyed on, scoped
-- to the family so a foreign membership id reads as "no such member".
SELECT om."user_id"
FROM "organization_members" om
WHERE om."organization_id" = $1 AND om."id" = $2;
