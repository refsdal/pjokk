-- Queries backing internal/auth. These read and write Limen's own tables,
-- which is deliberate and confined to one package: the Session our API
-- middleware consumes needs columns Limen's Go types do not expose (our
-- additional user fields, the organization plugin's active_organization_id),
-- and two Service methods have no actor-free entry point in the organization
-- plugin's API. See internal/auth/auth.go for the reasoning per method.

-- name: GetAuthSession :one
-- One round trip for everything SessionFromRequest needs beyond the token
-- itself. Keyed by (token, user_id) so a token can never resolve against a
-- different user than the one Limen just validated it for.
SELECT
    u."id" AS user_id,
    COALESCE(u."name", '') AS name,
    u."email" AS email,
    COALESCE(u."role", '') AS role,
    u."banned" AS banned,
    COALESCE(s."active_organization_id", '') AS active_family_id
FROM "sessions" s
JOIN "users" u ON u."id" = s."user_id"
WHERE s."token" = $1 AND s."user_id" = $2;

-- name: GetSessionRecord :one
-- The session's owner, its metadata blob (JSON in a text column, the shape
-- Limen's SessionSchema serialises) and the expiry used to size the restored
-- admin cookie.
SELECT
    "user_id" AS user_id,
    COALESCE("metadata", '') AS metadata,
    "expires_at" AS expires_at
FROM "sessions"
WHERE "token" = $1;

-- name: IsSessionUserBanned :one
-- The banned guard in front of Limen's own routes. Keyed on the raw token so
-- the guard costs one round trip and has no session-validation side effects
-- (Limen's ValidateSession can extend a session's expiry as it goes).
SELECT u."banned"
FROM "sessions" s
JOIN "users" u ON u."id" = s."user_id"
WHERE s."token" = $1;

-- name: CreateImpersonation :exec
-- Server-only: the admin's session token never goes into session metadata,
-- which its owner can read back (see 00003_impersonation.sql).
INSERT INTO "impersonation" ("impersonated_token", "admin_token", "admin_id")
VALUES ($1, $2, $3);

-- name: GetImpersonation :one
SELECT "admin_token", "admin_id"
FROM "impersonation"
WHERE "impersonated_token" = $1;

-- name: DeleteImpersonation :exec
DELETE FROM "impersonation"
WHERE "impersonated_token" = $1;

-- name: CountFamilyMembership :one
-- The membership guard for SetActiveFamily. A bare count, not GetMembership:
-- the caller only needs "is this user in this family", and a session must
-- never be pointed at a family whose data its owner may not read.
SELECT COUNT(*)::int
FROM "organization_members"
WHERE "organization_id" = $1 AND "user_id" = $2;

-- name: GetFamilyMember :one
SELECT "id", "organization_id", "user_id"
FROM "organization_members"
WHERE "organization_id" = $1 AND "id" = $2;

-- name: ClearActiveFamilyForUser :exec
-- Mirrors the organization plugin's own behaviour when a member is removed:
-- any session still pointing at that family is reset to "no active family",
-- so the next request cannot keep operating inside a family the user left.
UPDATE "sessions"
SET "active_organization_id" = NULL
WHERE "active_organization_id" = $1 AND "user_id" = $2;

-- name: DeleteFamilyMemberRoles :exec
DELETE FROM "organization_member_roles"
WHERE "organization_id" = $1 AND "member_id" = $2;

-- name: DeleteFamilyMember :exec
DELETE FROM "organization_members"
WHERE "organization_id" = $1 AND "id" = $2;

-- name: InsertFamilyMemberRole :exec
INSERT INTO "organization_member_roles" ("member_id", "organization_id", "role")
VALUES ($1, $2, $3);
