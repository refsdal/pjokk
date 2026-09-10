-- Queries backing the user profile (GET/PATCH /api/me, the avatar routes in
-- internal/api/avatar.go, and the Google import in avatar_import.go). All
-- user-scoped: a profile is global, not a family resource.

-- name: GetUserProfile :one
-- display_name is a generated column and therefore nullable to sqlc's eyes;
-- COALESCE so Go sees a string.
SELECT
    "id",
    COALESCE("name", '') AS name,
    "nickname",
    "phone",
    COALESCE("display_name", '') AS display_name,
    "units",
    "avatar_key",
    "avatar_imported_at",
    "image"
FROM "users"
WHERE "id" = $1;

-- name: UpdateUserProfile :exec
-- Full-row write of the three editable fields; the handler resolves the
-- PATCH tri-state (absent / null / value) before calling this.
UPDATE "users"
SET "name" = $2, "nickname" = $3, "phone" = $4, "units" = $5, "updated_at" = now()
WHERE "id" = $1;

-- name: SetUserAvatar :exec
-- NULL clears the photo. The caller deletes the previous object.
UPDATE "users"
SET "avatar_key" = $2, "updated_at" = now()
WHERE "id" = $1;

-- name: MarkAvatarImportAttempted :execrows
-- The atomic claim on the Google avatar import (internal/api/avatar_import.go):
-- the WHERE guard means only ONE of several concurrent callers can ever flip
-- this row from unattempted to attempted. 0 rows back means another request
-- already claimed the import (or a photo already exists); the caller must
-- treat that as "someone else has it" and do nothing further.
UPDATE "users"
SET "avatar_imported_at" = $2
WHERE "id" = $1 AND "avatar_imported_at" IS NULL AND "avatar_key" IS NULL;

-- name: GetAvatarForViewer :one
-- The viewer may see the target's photo when they ARE the target or share
-- at least one family with them. No row for anyone else — and no row for a
-- user without a photo — so the route answers 404 either way and never
-- confirms that a user id exists.
SELECT u."avatar_key"
FROM "users" u
WHERE u."id" = @target_id
  AND u."avatar_key" IS NOT NULL
  AND (
    u."id" = @viewer_id
    OR EXISTS (
      SELECT 1
      FROM "organization_members" a
      JOIN "organization_members" b ON b."organization_id" = a."organization_id"
      WHERE a."user_id" = @viewer_id AND b."user_id" = @target_id
    )
  );

-- name: GetAvatarForFamilyMember :one
-- GetAvatarForViewer for a kiosk device (spec 2026-09-10-kiosk-devices
-- §4): the target's photo when they are a member of the device's family.
-- Same 404-either-way contract — no row for a stranger or a missing photo.
SELECT u."avatar_key"
FROM "users" u
JOIN "organization_members" om ON om."user_id" = u."id"
WHERE u."id" = @target_id
  AND om."organization_id" = @family_id
  AND u."avatar_key" IS NOT NULL;
