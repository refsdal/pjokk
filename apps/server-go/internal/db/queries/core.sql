-- Core queries backing internal/db/gen (Task 3). Every domain query is
-- family-scoped (WHERE family_id = $1) per CLAUDE.md's tenancy discipline —
-- "family" is the product word for what the schema still calls
-- "organizations" (Limen's org plugin tables), ported from apps/api.

-- name: CreateBaby :one
INSERT INTO "baby" ("family_id", "name", "birth_date", "sex")
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ListBabies :many
SELECT * FROM "baby"
WHERE "family_id" = $1
ORDER BY "created_at";

-- name: GetBaby :one
SELECT * FROM "baby"
WHERE "family_id" = $1 AND "id" = $2;

-- name: UpdateBaby :one
UPDATE "baby"
SET "name" = $3, "birth_date" = $4, "sex" = $5
WHERE "family_id" = $1 AND "id" = $2
RETURNING *;

-- name: DeleteBaby :execrows
-- :execrows (not :exec) so the caller can tell "deleted" from "no such baby
-- in this family" — a 200 vs 404 distinction the handler needs and a plain
-- :exec can't report.
DELETE FROM "baby"
WHERE "family_id" = $1 AND "id" = $2;

-- name: GetFamilyBySlugless :one
-- Lookup by id (the FK grain everything else uses), not by slug — hence
-- "Slugless": there is no slug-based lookup here, deliberately, to avoid a
-- second untenanted entry point into the organizations table.
SELECT "id", "name", "slug", "plan" FROM "organizations"
WHERE "id" = $1;

-- name: GetMembership :one
-- organization_members carries no role column: Limen stores the role NAME on
-- organization_member_roles, one row per role a member holds (00002 aligned
-- that table to Limen's real shape — the organization_roles catalogue this
-- query used to join only exists when custom roles are enabled, which they
-- are not). Aggregate role names into an array so callers get one row per
-- (family, user) membership.
SELECT
    om."id",
    om."organization_id",
    om."user_id",
    om."created_at",
    o."plan",
    COALESCE(array_agg(omr."role") FILTER (WHERE omr."role" IS NOT NULL), '{}')::text[] AS roles
FROM "organization_members" om
JOIN "organizations" o ON o."id" = om."organization_id"
LEFT JOIN "organization_member_roles" omr ON omr."member_id" = om."id"
WHERE om."organization_id" = $1 AND om."user_id" = $2
GROUP BY om."id", om."organization_id", om."user_id", om."created_at", o."plan";

-- name: UpsertTombstone :exec
-- Belt-and-braces re-insert of the tombstone user the migration already
-- seeds (00001_init.sql), per REF §A2. Idempotent: ON CONFLICT DO NOTHING.
INSERT INTO "users" ("id", "email", "name", "banned")
VALUES ($1, 'deleted@pjokk.invalid', 'Deleted user', true)
ON CONFLICT DO NOTHING;
