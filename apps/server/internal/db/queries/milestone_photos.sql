-- Photos on milestones (issue #48; 00010_milestone_photo.sql). The same
-- shape as vaccines.sql's document queries: batched hydration for lists, a
-- single-log hydration for one row, keys-before-delete so the objects can
-- be removed after the rows are gone. Every query is family-scoped.

-- name: ListMilestonePhotosForLogs :many
SELECT "id", "milestone_log_id", "width", "height", "size"
FROM "milestone_photo"
WHERE "family_id" = sqlc.arg(family_id)
  AND "milestone_log_id" = ANY(sqlc.slice(milestone_log_ids))
ORDER BY "created_at" ASC, "id" ASC;

-- name: ListMilestonePhotosForLog :many
SELECT "id", "milestone_log_id", "width", "height", "size"
FROM "milestone_photo"
WHERE "family_id" = $1 AND "milestone_log_id" = $2
ORDER BY "created_at" ASC, "id" ASC;

-- name: CountMilestonePhotos :one
SELECT COUNT(*)::int
FROM "milestone_photo"
WHERE "family_id" = $1 AND "milestone_log_id" = $2;

-- name: SumMilestonePhotoBytes :one
-- Per-family usage against PHOTO_QUOTA_MB. SUM(integer) is bigint in
-- Postgres; the cast keeps codegen honest about it.
SELECT COALESCE(SUM("size"), 0)::bigint
FROM "milestone_photo"
WHERE "family_id" = $1;

-- name: CreateMilestonePhoto :one
INSERT INTO "milestone_photo"
    ("family_id", "milestone_log_id", "object_key", "width", "height", "size")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING "id";

-- name: GetMilestonePhoto :one
SELECT "id", "object_key", "width", "height", "size"
FROM "milestone_photo"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteMilestonePhoto :one
-- RETURNING the object_key so the caller deletes the stored bytes after
-- the row is gone; pgx.ErrNoRows means "not found or not ours".
DELETE FROM "milestone_photo"
WHERE "family_id" = $1 AND "id" = $2
RETURNING "object_key";

-- name: MilestonePhotoKeysForLog :many
-- Read BEFORE DeleteMilestone: the rows cascade away with the log, the
-- objects do not.
SELECT "object_key"
FROM "milestone_photo"
WHERE "family_id" = $1 AND "milestone_log_id" = $2;

-- name: MilestonePhotoKeysForBaby :many
-- Read BEFORE DeleteBaby (core.sql): the baby's milestones cascade away
-- with it, and their photo rows with them; the objects do not (issue #95).
-- Both sides of the join are held to the family.
SELECT p."object_key"
FROM "milestone_photo" p
JOIN "milestone_log" m ON m."id" = p."milestone_log_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND m."family_id" = sqlc.arg(family_id)
  AND m."baby_id" = sqlc.arg(baby_id);

-- name: MilestonePhotoKeysForFamily :many
-- Read BEFORE DeleteOrganization (admin.sql): everything the family owns
-- cascades away with it, the objects behind its photos do not (issue #95).
SELECT "object_key"
FROM "milestone_photo"
WHERE "family_id" = $1;
