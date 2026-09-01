-- Queries backing the /api/keys admin surface (Task 19; REF §A1 keys.ts).
-- The authentication-time lookup (GetAPIKeyByHash) and last-used bookkeeping
-- (TouchAPIKey) live in queries/middleware.sql — this file is only the
-- family-admin management surface: create, list, revoke.

-- name: CreateAPIKey :one
-- The raw bearer token itself is never persisted — only its SHA-256 hex
-- digest (key_hash) and a displayable prefix (internal/api/keys.go). The
-- caller supplies both already computed, plus expires_at/read_only.
INSERT INTO "api_key" ("family_id", "name", "key_hash", "prefix", "created_by", "expires_at", "read_only")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListAPIKeys :many
-- Every key ever issued to the family, revoked or not, newest first — the
-- admin surface shows the full history so a revoked key's audit trail
-- (name, when, by whom it once authenticated) stays visible even after
-- revocation.
SELECT * FROM "api_key"
WHERE "family_id" = $1
ORDER BY "created_at" DESC;

-- name: RevokeAPIKey :execrows
-- Soft-delete: sets revoked_at rather than removing the row, so
-- GetAPIKeyByHash's "revoked_at IS NULL" filter makes a revoked key
-- indistinguishable from one that never existed to APIKeyAuth, while the
-- row (and its audit trail) survives for the admin list. The "revoked_at IS
-- NULL" guard here means revoking an already-revoked key affects zero rows
-- — reported as 404, same as an unknown id (apps/api/src/db/scoped.ts's
-- revokeApiKey has the identical guard).
UPDATE "api_key"
SET "revoked_at" = $3
WHERE "id" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;
