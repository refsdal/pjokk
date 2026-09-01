-- +goose Up

-- ===========================================================================
-- Limen schema alignment.
--
-- 00001_init.sql wrote the auth tables best-effort from REF §B4's prose column
-- lists, before any Limen code had been run. This migration replaces the
-- guesses with Limen's real expectations, read off the library itself: with
-- `Config.CLI` enabled Limen serialises its resolved schema to
-- `.limen/schemas.json`, and `limen generate migrations --driver postgres
-- --dsn …` diffs that against a live database. Everything below is either
-- straight out of that diff or a not-null column Limen never writes (which
-- the diff cannot see, because it only ever proposes additions).
--
-- Limen does not auto-migrate and does not validate the schema at startup:
-- every mismatch here would otherwise have surfaced as a runtime SQL error on
-- the first sign-in, organization create, or member add.
-- ===========================================================================

-- users: no change. Limen's user INSERT writes id/email/password/
-- email_verified_at/first_name/last_name/created_at/updated_at; our extra
-- columns (public_id, name, image, role, banned, ban_reason, deleted_at) are
-- each nullable or defaulted, and `name`/`image` are supplied explicitly
-- through Limen's additionalFields map (credential signup) and the OAuth
-- plugin's MapProfileToUser (Google sign-in). Nothing to align.

-- organizations: Limen's organization INSERT writes id/name/slug/logo/
-- metadata/created_at/updated_at and nothing else, so our guessed
-- `user_id NOT NULL` would fail every CreateOrganization with a not-null
-- violation. Ownership is already carried by organization_members plus the
-- creator's row in organization_member_roles, so the column is redundant as
-- well as fatal.
ALTER TABLE "organizations" DROP COLUMN "user_id";

-- sessions: the index the organization plugin declares for its
-- active_organization_id extension.
CREATE INDEX "idx_sessions_active_organization" ON "sessions" ("active_organization_id");

-- verifications: Limen's column is "subject", not "identifier". Renamed
-- rather than aliased through WithVerificationFieldSubject so the table reads
-- the same as Limen's own documentation.
ALTER TABLE "verifications" RENAME COLUMN "identifier" TO "subject";
ALTER INDEX "verifications_identifier_idx" RENAME TO "idx_verifications_subject";
CREATE UNIQUE INDEX "idx_verifications_value" ON "verifications" ("value");

-- rate_limits (Limen's own limiter table — distinct from our "rate_limit"):
-- Limen tracks the window with an epoch-millisecond `last_request_at`, not an
-- `expires_at` timestamp. Ours was NOT NULL, so a counter write would have
-- failed; and the column Limen does write did not exist.
ALTER TABLE "rate_limits" DROP COLUMN "expires_at";
ALTER TABLE "rate_limits" ADD COLUMN "last_request_at" bigint NOT NULL DEFAULT 0;

-- organization_members: Limen writes updated_at on create and update, and
-- relies on (organization_id, user_id) being unique.
ALTER TABLE "organization_members" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX "idx_organization_members_org_user" ON "organization_members" ("organization_id", "user_id");

-- organization_member_roles: the guessed shape was a pure join table between
-- organization_members and a organization_roles catalogue. Limen instead
-- stores the role NAME on the join row and only materialises an
-- organization_roles table when custom roles are enabled — which they are
-- not here (Pjokk's roles are the built-in owner/admin/member). Recreated to
-- Limen's shape, and the now-unreferenced catalogue dropped.
DROP TABLE "organization_member_roles";
DROP TABLE "organization_roles";

CREATE TABLE "organization_member_roles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"member_id" text NOT NULL REFERENCES "organization_members" ("id") ON DELETE CASCADE,
	"organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"role" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "idx_organization_member_roles_member_role" ON "organization_member_roles" ("member_id", "role");
CREATE INDEX "organization_member_roles_org_idx" ON "organization_member_roles" ("organization_id");

-- organization_invitations: unused by Pjokk (our invite mechanism is the
-- domain family_invite table), but the organization plugin registers the
-- schema, so it is aligned rather than left as a landmine. `roles` (plural,
-- a JSON array) replaces the guessed singular `role`; `token` is the
-- invitation's lookup key; expires_at/inviter_id are nullable in Limen.
ALTER TABLE "organization_invitations" DROP COLUMN "role";
ALTER TABLE "organization_invitations" ADD COLUMN "roles" text;
ALTER TABLE "organization_invitations" ADD COLUMN "token" text NOT NULL;
ALTER TABLE "organization_invitations" ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "organization_invitations" ALTER COLUMN "expires_at" DROP NOT NULL;
ALTER TABLE "organization_invitations" ALTER COLUMN "inviter_id" DROP NOT NULL;
CREATE UNIQUE INDEX "idx_organization_invitations_token" ON "organization_invitations" ("token");

-- +goose Down

DROP INDEX IF EXISTS "idx_organization_invitations_token";
ALTER TABLE "organization_invitations" ALTER COLUMN "inviter_id" SET NOT NULL;
ALTER TABLE "organization_invitations" ALTER COLUMN "expires_at" SET NOT NULL;
ALTER TABLE "organization_invitations" DROP COLUMN "updated_at";
ALTER TABLE "organization_invitations" DROP COLUMN "token";
ALTER TABLE "organization_invitations" DROP COLUMN "roles";
ALTER TABLE "organization_invitations" ADD COLUMN "role" text;

DROP TABLE "organization_member_roles";

CREATE TABLE "organization_roles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "organization_roles_org_idx" ON "organization_roles" ("organization_id");

CREATE TABLE "organization_member_roles" (
	"organization_member_id" text NOT NULL REFERENCES "organization_members" ("id") ON DELETE CASCADE,
	"organization_role_id" text NOT NULL REFERENCES "organization_roles" ("id") ON DELETE CASCADE,
	CONSTRAINT "organization_member_roles_pk" PRIMARY KEY ("organization_member_id", "organization_role_id")
);

DROP INDEX IF EXISTS "idx_organization_members_org_user";
ALTER TABLE "organization_members" DROP COLUMN "updated_at";

ALTER TABLE "rate_limits" DROP COLUMN "last_request_at";
ALTER TABLE "rate_limits" ADD COLUMN "expires_at" timestamptz NOT NULL DEFAULT now();

DROP INDEX IF EXISTS "idx_verifications_value";
ALTER INDEX "idx_verifications_subject" RENAME TO "verifications_identifier_idx";
ALTER TABLE "verifications" RENAME COLUMN "subject" TO "identifier";

DROP INDEX IF EXISTS "idx_sessions_active_organization";

ALTER TABLE "organizations" ADD COLUMN "user_id" text REFERENCES "users" ("id") ON DELETE CASCADE;
