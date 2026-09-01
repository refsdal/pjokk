-- Queries backing the /api/invites admin + public + redeem surface
-- (Task 20; REF §A1 invites.ts). family_invite is Pjokk's own domain table
-- (QR-at-Sunday-dinner grain, not Limen's email-addressed
-- organization_invitations, which this port never touches — see
-- 00001_init.sql/00002_limen_align.sql's comments on that table).
--
-- InsertOrganizationMember writes directly into Limen's own
-- organization_members table — the redeem transaction cannot go through
-- auth.Service.AddMember (see internal/api/invites.go's package doc
-- comment for why: it opens its own transaction, and the membership
-- insert + used_count increment must commit or roll back together).
-- Its column list mirrors exactly what the organization plugin's
-- insertMemberWithRole writes (organization_id, user_id only — id/
-- created_at/updated_at all default): read off
-- github.com/thecodearcher/limen/plugins/organization's members.go. The
-- companion role row reuses auth.sql's InsertFamilyMemberRole rather than
-- duplicating it here — same INSERT the organization plugin's
-- assignMemberRole issues.

-- name: CreateInvite :one
INSERT INTO "family_invite" ("code", "family_id", "role", "expires_at", "max_uses", "created_by")
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: ListInvites :many
-- Every code ever issued for the family, newest first — used and revoked
-- ones included, same as ListAPIKeys' rationale (the admin view is the
-- audit trail).
SELECT * FROM "family_invite"
WHERE "family_id" = $1
ORDER BY "created_at" DESC;

-- name: RevokeInvite :execrows
-- Guarded the same way RevokeAPIKey is: "revoked_at IS NULL" means
-- revoking an already-revoked code, or a code from another family, both
-- affect zero rows — reported as 404, the caller cannot tell the two
-- apart (apps/api/src/db/scoped.ts's revokeInvite).
UPDATE "family_invite"
SET "revoked_at" = $3
WHERE "code" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;

-- name: GetInviteByCode :one
-- The public/optimistic read (info endpoint, and redeem's first read
-- before the locking transaction). Deliberately NOT family-scoped: a
-- code is the tenancy boundary here, there is no session/family yet.
SELECT * FROM "family_invite"
WHERE "code" = $1;

-- name: GetInviteByCodeForUpdate :one
-- The locking re-read inside the redeem transaction (see
-- internal/api/invites.go's RedeemInvite): SELECT … FOR UPDATE serializes
-- concurrent redeems of the same code, so max_uses is genuinely enforced
-- rather than merely difficult to exceed (apps/api/src/routes/invites.ts's
-- comment on the same point, from when this was a D1 batch that could
-- only approximate it).
SELECT * FROM "family_invite"
WHERE "code" = $1
FOR UPDATE;

-- name: IncrementInviteUsedCount :exec
UPDATE "family_invite"
SET "used_count" = "used_count" + 1
WHERE "code" = $1;

-- name: InsertOrganizationMember :one
INSERT INTO "organization_members" ("organization_id", "user_id")
VALUES ($1, $2)
RETURNING "id";
