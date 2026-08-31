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

-- name: DeleteBaby :exec
DELETE FROM "baby"
WHERE "family_id" = $1 AND "id" = $2;

-- name: GetFamilyBySlugless :one
-- Lookup by id (the FK grain everything else uses), not by slug — hence
-- "Slugless": there is no slug-based lookup here, deliberately, to avoid a
-- second untenanted entry point into the organizations table.
SELECT "id", "name", "slug", "plan" FROM "organizations"
WHERE "id" = $1;

-- name: GetMembership :one
-- organization_members carries no role column: role assignment lives in the
-- join table organization_member_roles -> organization_roles (a member can
-- hold zero or more named roles). Aggregate role names into an array so
-- callers get one row per (family, user) membership, same grain as before.
SELECT
    om."id",
    om."organization_id",
    om."user_id",
    om."created_at",
    o."plan",
    COALESCE(array_agg(orr."name") FILTER (WHERE orr."name" IS NOT NULL), '{}')::text[] AS roles
FROM "organization_members" om
JOIN "organizations" o ON o."id" = om."organization_id"
LEFT JOIN "organization_member_roles" omr ON omr."organization_member_id" = om."id"
LEFT JOIN "organization_roles" orr ON orr."id" = omr."organization_role_id"
WHERE om."organization_id" = $1 AND om."user_id" = $2
GROUP BY om."id", om."organization_id", om."user_id", om."created_at", o."plan";

-- name: UpsertTombstone :exec
-- Belt-and-braces re-insert of the tombstone user the migration already
-- seeds (00001_init.sql), per REF §A2. Idempotent: ON CONFLICT DO NOTHING.
INSERT INTO "users" ("id", "email", "name", "banned")
VALUES ($1, 'deleted@pjokk.invalid', 'Deleted user', true)
ON CONFLICT DO NOTHING;
