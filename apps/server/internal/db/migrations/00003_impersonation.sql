-- +goose Up

-- ===========================================================================
-- Server-only impersonation bookkeeping.
--
-- The admin's session token used to live in the impersonated session's JSON
-- metadata. That was a privilege-escalation hole: Limen's own
-- `GET /api/auth/sessions` serialises a session's Token AND Metadata to the
-- session's owner, so the impersonated user could read the admin's token out
-- of their own session and set it as their cookie. The route is now disabled
-- as well, but the token has no business being anywhere the session's owner
-- can reach — so it moves here, to a table nothing outside internal/auth
-- ever reads.
--
-- Only the non-sensitive marker (impersonated_by, a user id) stays in
-- session metadata, where SessionFromRequest reads it for the in-app banner.
--
-- Both foreign keys cascade on purpose: revoking either session — through
-- StopImpersonating, RevokeAllSessions, an admin signing out, or expiry
-- cleanup — takes the row with it, so no code path has to remember to tidy
-- up and a stale row can never resurrect a dead token.
-- ===========================================================================

CREATE TABLE "impersonation" (
	"impersonated_token" text PRIMARY KEY REFERENCES "sessions" ("token") ON DELETE CASCADE,
	"admin_token" text NOT NULL REFERENCES "sessions" ("token") ON DELETE CASCADE,
	"admin_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "impersonation_admin_idx" ON "impersonation" ("admin_id");
CREATE INDEX "impersonation_admin_token_idx" ON "impersonation" ("admin_token");

-- +goose Down

DROP TABLE IF EXISTS "impersonation";
