-- Core queries backing internal/db/gen. Every domain query is
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
-- seeds (00001_init.sql). Idempotent: ON CONFLICT DO NOTHING.
INSERT INTO "users" ("id", "email", "name", "banned")
VALUES ($1, 'deleted@pjokk.invalid', 'Deleted user', true)
ON CONFLICT DO NOTHING;

-- name: ValidBabyIDs :many
-- Tenancy backstop for a caller-supplied set of baby ids (calendar's
-- babyIds, contacts' babyIds — join tables carry no family_id of their
-- own): which of ids actually belong to this family. Callers (see
-- internal/api/calendar.go's/contacts.go's refsValid) compare
-- len(result) against len(the deduped input) rather than existence-check
-- one id at a time.
SELECT "id" FROM "baby"
WHERE "family_id" = $1 AND "id" = ANY(sqlc.slice(ids));

-- name: ValidFamilyMemberUserIDs :many
-- Same backstop as ValidBabyIDs, for calendar's assigneeUserIds: which of
-- ids are members of this family. organization_members is Limen's own
-- membership table (see GetMembership above) — no role check here, any
-- member (parent or caretaker) can be assigned.
SELECT "user_id" FROM "organization_members"
WHERE "organization_id" = $1 AND "user_id" = ANY(sqlc.slice(ids));

-- name: MostRecentMembership :one
-- The family a user most recently joined — used to auto-activate a session
-- that has no active organization yet (a returning user's fresh sign-in),
-- so they land in a family rather than being told to create one they
-- already belong to. Multi-family users can still switch; this just picks a
-- sane default.
SELECT om."organization_id"
FROM "organization_members" om
WHERE om."user_id" = $1
ORDER BY om."created_at" DESC, om."organization_id" DESC
LIMIT 1;

-- name: SetBabyAvatar :one
-- NULL clears the photo. The caller deletes the previous object
-- (internal/api/baby_avatar.go). RETURNING * so the route answers with the
-- Baby as it now is.
UPDATE "baby"
SET "avatar_key" = $3
WHERE "family_id" = $1 AND "id" = $2
RETURNING *;

-- name: GetBabyAvatarKey :one
-- The streaming read's lookup: no row for another family's baby, and none
-- for a baby without a photo, so the route answers 404 either way and
-- never confirms that a baby id exists.
SELECT "avatar_key"
FROM "baby"
WHERE "family_id" = $1 AND "id" = $2 AND "avatar_key" IS NOT NULL;

-- name: BabyAvatarKeysForFamily :many
-- Read BEFORE DeleteOrganization (admin.sql): the babies cascade away with
-- the family, the objects behind their photos do not (issue #95).
SELECT "avatar_key"::text
FROM "baby"
WHERE "family_id" = $1 AND "avatar_key" IS NOT NULL;

-- name: SetBabyFeatures :one
-- The per-baby tracking switches (00033), replaced whole. RETURNING * so
-- the route answers with the Baby, as UpdateBaby does.
UPDATE "baby"
SET "features" = $3
WHERE "family_id" = $1 AND "id" = $2
RETURNING *;

-- name: BabyTracks :one
-- Does this baby — or, with no baby, ANY baby of the family — track this
-- feature? What the reminder and closing-alert jobs ask before firing
-- (internal/jobs): a reminder with no baby applies to each baby that has
-- the kind on, so it is held only when none does.
SELECT EXISTS (
    SELECT 1 FROM "baby"
    WHERE "family_id" = sqlc.arg(family_id)
      AND (sqlc.narg(baby_id)::text IS NULL OR "id" = sqlc.narg(baby_id))
      AND sqlc.arg(feature)::text = ANY("features")
)::bool AS tracked;
