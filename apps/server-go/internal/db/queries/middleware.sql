-- Queries backing the request pipeline: the rate-limit counters
-- (internal/ratelimit) and the tenancy/auth middleware chain
-- (internal/api/middleware). See REF §A5 for the semantics each one serves.

-- name: HitRateLimit :one
-- One atomic increment, replacing the KV-era read-compare-write. The counter
-- is exact even when several replicas serve the same caller concurrently,
-- which is the whole reason the limiter moved into Postgres.
--
-- expires_at is only written on INSERT: the key already carries its window
-- number (`rl:{name}:{bucket}:{window}`), so a bucket never outlives the
-- window it was created for and refreshing the expiry on every hit would
-- only let a busy bucket linger.
INSERT INTO "rate_limit" ("key", "count", "expires_at")
VALUES ($1, 1, $2)
ON CONFLICT ("key") DO UPDATE SET "count" = "rate_limit"."count" + 1
RETURNING "count";

-- name: SweepRateLimit :execrows
-- Housekeeping for the counters the nightly job prunes. Returns the number
-- of rows removed.
DELETE FROM "rate_limit"
WHERE "expires_at" < $1;

-- name: GetAPIKeyByHash :one
-- The api-key authentication join (REF §A5 item 5). The key authenticates as
-- the caretaker who created it — their attribution ends up on the logs — and
-- is scoped to the key's family, so the user and the organization are joined
-- in rather than looked up separately.
--
-- Revoked keys are filtered here rather than reported separately: a revoked
-- key must be indistinguishable from one that never existed.
SELECT
    k."id",
    k."family_id",
    k."last_used_at",
    k."expires_at",
    k."read_only",
    u."id" AS user_id,
    COALESCE(u."name", '') AS user_name,
    u."email" AS user_email,
    o."plan"
FROM "api_key" k
JOIN "users" u ON u."id" = k."created_by"
JOIN "organizations" o ON o."id" = k."family_id"
WHERE k."key_hash" = $1 AND k."revoked_at" IS NULL;

-- name: TouchAPIKey :exec
-- Coarse last-used tracking: the middleware calls this at most once per five
-- minutes per key, not once per request.
UPDATE "api_key"
SET "last_used_at" = $2
WHERE "id" = $1;

-- name: GetFamilyMembershipRole :one
-- The tenancy gate's one query: does this user hold a membership row in this
-- family, and what role + plan does the request run under.
--
-- An active_organization_id on the session is NOT proof of membership (a
-- member removed from a family keeps the column until their next switch), so
-- the row's existence is the check — a missing row is REF §A5's 403
-- NOT_MEMBER.
--
-- The role lives on organization_member_roles, one row per role held
-- (00002_limen_align.sql). Pjokk assigns exactly one — SetMemberRole is
-- delete-then-insert — so the lateral picks a single row; ORDER BY makes the
-- choice deterministic if a future path ever writes two ('admin' sorts before
-- 'member' and 'owner', so the more privileged role wins a tie, matching the
-- single-role column the TypeScript predecessor read).
SELECT
    COALESCE(r."role", '') AS role,
    o."plan"
FROM "organization_members" om
JOIN "organizations" o ON o."id" = om."organization_id"
LEFT JOIN LATERAL (
    SELECT omr."role"
    FROM "organization_member_roles" omr
    WHERE omr."member_id" = om."id"
    ORDER BY omr."role"
    LIMIT 1
) r ON true
WHERE om."organization_id" = $1 AND om."user_id" = $2
LIMIT 1;

-- name: InsertAdminAudit :exec
-- The append-only system-admin trail. Used by the middleware for
-- `impersonated.write` (REF §A5 item 2) and by the admin console for
-- everything else.
INSERT INTO "admin_audit" ("admin_id", "action", "target", "detail")
VALUES ($1, $2, $3, $4);
