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
-- The member's own most-privileged role rides along in the same row, via
-- the same explicit admin/owner/other CASE order GetFamilyMembershipRole
-- (middleware.sql) and ListFamilyMembers (family.sql) use rather than a
-- lexicographic sort. RemoveMember/SetMemberRole need it for the
-- last-admin guard (see CountFamilyAdmins below) and would otherwise cost
-- a second round trip just to learn whether the target member is even a
-- candidate for that check.
SELECT
    om."id",
    om."organization_id",
    om."user_id",
    COALESCE(r."role", '') AS role
FROM "organization_members" om
LEFT JOIN LATERAL (
    SELECT omr."role"
    FROM "organization_member_roles" omr
    WHERE omr."member_id" = om."id"
    ORDER BY CASE omr."role"
        WHEN 'admin' THEN 0
        WHEN 'owner' THEN 1
        ELSE 2
    END, omr."role"
    LIMIT 1
) r ON true
WHERE om."organization_id" = $1 AND om."id" = $2;

-- name: CountFamilyAdmins :one
-- How many members in this family currently hold the admin/owner
-- privilege level (same CASE order as GetFamilyMember above). Backs the
-- last-admin guard in RemoveMember/SetMemberRole: removing or demoting the
-- sole admin/owner would leave a family that cannot manage its own
-- settings, invites, or deletes — a server-side mirror of the guard the
-- SPA already applies client-side.
SELECT COUNT(*)::int
FROM "organization_members" om
JOIN LATERAL (
    SELECT omr."role"
    FROM "organization_member_roles" omr
    WHERE omr."member_id" = om."id"
    ORDER BY CASE omr."role"
        WHEN 'admin' THEN 0
        WHEN 'owner' THEN 1
        ELSE 2
    END, omr."role"
    LIMIT 1
) r ON true
WHERE om."organization_id" = $1 AND r."role" IN ('admin', 'owner');

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

-- name: SetUserPassword :exec
-- Replace an account's password hash outright (Task 21's admin reset).
--
-- Limen's own credential plugin cannot express this: its SetPassword only
-- establishes a FIRST password (ErrPasswordAlreadySet otherwise) and its
-- UpdatePassword requires the CURRENT password, which an administrator
-- resetting a forgotten one does not have. The hash itself still comes from
-- Limen (cred.HashPassword), so the stored value is byte-compatible with
-- what its sign-in comparison expects; only the write is ours.
UPDATE "users" SET "password" = $2, "updated_at" = now() WHERE "id" = $1;

-- name: IsUserBanned :one
-- Ban state for a user id, for the impersonation check in resolveSession:
-- an impersonated session is only as valid as the OPERATOR behind it. No
-- rows means the account is gone, which the caller treats the same way.
SELECT "banned" FROM "users" WHERE "id" = $1;

-- name: ListImpersonatedTokensByAdmin :many
-- Every live impersonated session this operator is driving.
--
-- Banning, deleting, or signing out a user revokes the sessions whose
-- user_id is theirs — which does NOT include a session they are
-- impersonating, since that one belongs to the target. Without this list
-- those sessions outlive the operator's own access. Served by
-- impersonation_admin_idx (00003_impersonation.sql).
SELECT "impersonated_token" FROM "impersonation" WHERE "admin_id" = $1;

-- name: GetUserRole :one
-- Backs allowOrgCreation (see auth.go): the system-admin role that opens
-- /admin lives on this column, not on any family membership.
SELECT COALESCE("role", '') FROM "users" WHERE "id" = $1;

-- name: CountMembershipsForUser :one
-- Every family this user belongs to, across ALL organizations — unlike
-- CountFamilyMembership (scoped to one organization_id), this backs
-- allowOrgCreation's "no existing family yet" self-serve-founding check.
SELECT COUNT(*)::int FROM "organization_members" WHERE "user_id" = $1;

-- name: SetSessionActiveOrg :exec
-- Persist a session's active organization directly (bypassing the org
-- plugin), used to auto-activate a returning user's fresh session in the
-- resolution path. WHERE active_organization_id IS NULL guards against
-- clobbering a family the user explicitly switched to in a concurrent
-- request.
UPDATE "sessions"
SET "active_organization_id" = $2
WHERE "token" = $1 AND "active_organization_id" IS NULL;
