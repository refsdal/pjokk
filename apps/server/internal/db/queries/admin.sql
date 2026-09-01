-- Queries backing the system-admin console (Task 21; REF §A1 admin.ts):
-- platform stats, the family overview, safe account deletion, the user
-- support surface (list/ban/unban) and the append-only audit trail.
--
-- The audit INSERT itself lives in queries/middleware.sql
-- (InsertAdminAudit) — it is shared with the middleware's
-- `impersonated.write` trail, which has no business importing an
-- admin-console query file.

-- name: GetAdminStats :one
-- One round trip for the whole /admin dashboard.
--
-- Every COUNT is cast to int explicitly. COUNT() is bigint in Postgres and
-- pgx hands bigints back as int64 into a field sqlc would type accordingly
-- — the ::int keeps the generated struct's fields plain ints, matching the
-- spec's integer properties, and mirrors the ::int the TypeScript
-- predecessor needed for a stronger reason (its driver returned bigints as
-- STRINGS).
--
-- `users` counts every row including the "Deleted user" tombstone, exactly
-- as the TypeScript predecessor did once ensureTombstone had created it.
-- $1 is the start of the "last 7 days" window, supplied by the caller's
-- clock (Deps.Now) rather than now(), so a test can pin it.
SELECT
    (SELECT COUNT(*)::int FROM "organizations") AS families,
    (SELECT COUNT(*)::int FROM "users") AS users,
    (SELECT COUNT(*)::int FROM "baby") AS babies,
    (
        (SELECT COUNT(*)::int FROM "feed_log")
        + (SELECT COUNT(*)::int FROM "diaper_log")
        + (SELECT COUNT(*)::int FROM "sleep_log")
    ) AS core_logs,
    (SELECT COUNT(*)::int FROM "push_subscription") AS push_subscriptions,
    (SELECT COUNT(*)::int FROM "users" recent WHERE recent."created_at" > $1) AS users_last_7d;

-- name: ListAdminFamilies :many
-- Every family, newest first, with its member and baby counts and the
-- timestamp of its most recent feed.
--
-- Correlated subqueries rather than the TypeScript predecessor's
-- leftJoin(feed_log) + groupBy: that join multiplied the organization row
-- by every feed before collapsing it again, which is why the member and
-- baby counts had to be subqueries there too. Three subqueries say the
-- same thing without the fan-out.
SELECT
    o."id",
    o."name",
    o."slug",
    o."plan",
    o."created_at",
    (SELECT COUNT(*)::int FROM "organization_members" m WHERE m."organization_id" = o."id") AS members,
    (SELECT COUNT(*)::int FROM "baby" b WHERE b."family_id" = o."id") AS babies,
    -- The ::timestamptz cast is load-bearing for codegen, not for
    -- Postgres: without it sqlc types the aggregate as interface{} and the
    -- Go side loses the Timestamptz scan.
    (SELECT MAX(f."time") FROM "feed_log" f WHERE f."family_id" = o."id")::timestamptz AS last_feed_at
FROM "organizations" o
ORDER BY o."created_at" DESC;

-- name: GetOrganizationName :one
-- The existence check + audit detail for DELETE /api/admin/families/{id}:
-- a missing row is the route's 404, and the name is what the audit entry
-- records (the id alone is useless once the row is gone).
SELECT "name" FROM "organizations" WHERE "id" = $1;

-- name: DeleteOrganization :execrows
-- Everything the family owns cascades: members, invites, babies, keys and
-- every log. Nothing here cancels a subscription — billing is gone from
-- this port entirely (REF §A1: "Stripe cancel/subscription rows GONE in
-- Go").
DELETE FROM "organizations" WHERE "id" = $1;

-- name: ListAdminUsers :many
-- The user-support list. NEW in Go (REF §A1's "NEW in Go" table): the
-- TypeScript app got this from better-auth's admin plugin over
-- /api/auth/admin/list-users, which this port does not have.
--
-- sqlc.narg('query') is NULL when the caller sent no filter, in which case
-- the whole WHERE collapses to true. The ILIKE pattern is built with
-- ||-concatenation so the search text is a bound parameter, never spliced
-- into SQL. `role` and `name` are nullable columns; COALESCE keeps the
-- generated Go fields plain strings for name (always rendered) while role
-- stays a pointer (the spec's nullable "admin" or null).
SELECT
    "id",
    COALESCE("name", '') AS name,
    "email",
    "role",
    "banned",
    "ban_reason",
    "created_at"
FROM "users"
WHERE
    sqlc.narg('query')::text IS NULL
    OR "name" ILIKE '%' || sqlc.narg('query')::text || '%'
    OR "email" ILIKE '%' || sqlc.narg('query')::text || '%'
ORDER BY "created_at" DESC
LIMIT sqlc.arg('lim');

-- name: GetAdminUser :one
-- The existence check every /api/admin/users/{id}/… action runs first, and
-- the source of the audit detail (the email — an id in the trail is
-- unreadable once the account is gone). `banned` is read by the
-- impersonation guard.
SELECT "id", COALESCE("name", '') AS name, "email", "banned"
FROM "users"
WHERE "id" = $1;

-- name: BanAdminUser :exec
-- Sets the flag and the reason. This is NOT by itself a revocation: the
-- caller MUST also revoke the user's sessions (auth.Service's own doc
-- comment says so), and their API keys stop working because
-- GetAPIKeyByHash joins on a non-banned creator.
UPDATE "users" SET "banned" = true, "ban_reason" = $2 WHERE "id" = $1;

-- name: UnbanAdminUser :exec
-- Clears both the flag and the stale reason. Sessions revoked by the ban
-- stay revoked — the user signs in again.
UPDATE "users" SET "banned" = false, "ban_reason" = NULL WHERE "id" = $1;

-- name: ListAdminAudit :many
-- The 100 most recent entries in the append-only trail, newest first.
--
-- An INNER JOIN is safe even for a deleted admin: ReassignUserReferences
-- below points their audit rows at the tombstone user before the account
-- is removed, so every admin_id always resolves.
SELECT
    a."id",
    a."admin_id",
    COALESCE(u."name", '') AS admin_name,
    a."action",
    a."target",
    a."detail",
    a."created_at"
FROM "admin_audit" a
JOIN "users" u ON u."id" = a."admin_id"
ORDER BY a."created_at" DESC, a."id" DESC
LIMIT 100;

-- name: ReassignUserReferences :exec
-- The complete set of references a user account must shed before it can be
-- deleted, in ONE statement.
--
-- Every foreign key to "users" in the schema is either ON DELETE CASCADE
-- (sessions, accounts, organization_members, organization_invitations,
-- push_subscription, push_pref, impersonation — all correctly taken with
-- the account) or a non-cascading attribution that must survive the
-- delete. This statement covers every one of the latter, and
-- internal/api's TestUserDeleteCoversEveryNonCascadingUserReference asks
-- the live schema whether that is still true — so a migration that adds a
-- new attributed table fails a test rather than failing an account deletion
-- in production.
--
-- Written as one data-modifying CTE rather than one query per table
-- so the completeness argument above is checkable in a single place. All
-- branches see the same snapshot and run in the same statement; the
-- trailing SELECT exists only because a CTE needs a primary statement.
--
-- Two things this list does that the TypeScript predecessor's did not:
--
--   1. play_log, vaccine_log, vaccine_document and vaccine_dismissal are
--      included. apps/api/src/routes/admin.ts enumerated only nine log
--      tables and never grew the four Phase-10 ones — a latent bug there
--      (deleting a user who ever logged a play session or a vaccine would
--      have failed on the FK), not a behaviour worth porting.
--   2. api_key.revoked_at is COALESCEd rather than overwritten, so a key
--      revoked last year keeps its real revocation timestamp instead of
--      being restamped with the deletion time.
--
-- Not here, and deliberately so: organizations.user_id. Limen ships that
-- column (the family's creator) with ON DELETE CASCADE, which would take a
-- whole family down with its creator's account — but 00002_limen_align.sql
-- DROPS it in its Up (it made every CreateOrganization fail on a not-null
-- violation), so no such column exists in the live schema. Note that sqlc's
-- schema view disagrees: it reads the migration files without honouring
-- goose's Up/Down markers, so the ADD COLUMN in 00002's Down section is
-- visible to codegen and a query referencing organizations.user_id compiles
-- happily and then fails at runtime with SQLSTATE 42703. If that column is
-- ever reintroduced for real, it MUST be reassigned here.
--
-- calendar_assignee is deliberately NOT here: an assignment is not an
-- attribution, pointing it at the tombstone would be meaningless, and the
-- (event_id, user_id) primary key could collide if the tombstone were
-- already assigned. Those rows are deleted instead — see
-- DeleteCalendarAssigneesForUser.
WITH
    sleep AS (UPDATE "sleep_log" SET "caretaker_id" = @tombstone_id WHERE "sleep_log"."caretaker_id" = @user_id),
    feed AS (UPDATE "feed_log" SET "caretaker_id" = @tombstone_id WHERE "feed_log"."caretaker_id" = @user_id),
    diaper AS (UPDATE "diaper_log" SET "caretaker_id" = @tombstone_id WHERE "diaper_log"."caretaker_id" = @user_id),
    medicine AS (UPDATE "medicine_log" SET "caretaker_id" = @tombstone_id WHERE "medicine_log"."caretaker_id" = @user_id),
    bath AS (UPDATE "bath_log" SET "caretaker_id" = @tombstone_id WHERE "bath_log"."caretaker_id" = @user_id),
    note AS (UPDATE "note_log" SET "caretaker_id" = @tombstone_id WHERE "note_log"."caretaker_id" = @user_id),
    milestone AS (UPDATE "milestone_log" SET "caretaker_id" = @tombstone_id WHERE "milestone_log"."caretaker_id" = @user_id),
    measurement AS (UPDATE "measurement_log" SET "caretaker_id" = @tombstone_id WHERE "measurement_log"."caretaker_id" = @user_id),
    pump AS (UPDATE "pump_log" SET "caretaker_id" = @tombstone_id WHERE "pump_log"."caretaker_id" = @user_id),
    play AS (UPDATE "play_log" SET "caretaker_id" = @tombstone_id WHERE "play_log"."caretaker_id" = @user_id),
    vaccine AS (UPDATE "vaccine_log" SET "caretaker_id" = @tombstone_id WHERE "vaccine_log"."caretaker_id" = @user_id),
    vaccine_doc AS (UPDATE "vaccine_document" SET "uploaded_by" = @tombstone_id WHERE "vaccine_document"."uploaded_by" = @user_id),
    vaccine_dismissal AS (UPDATE "vaccine_dismissal" SET "dismissed_by" = @tombstone_id WHERE "vaccine_dismissal"."dismissed_by" = @user_id),
    invite AS (UPDATE "family_invite" SET "created_by" = @tombstone_id WHERE "family_invite"."created_by" = @user_id),
    key AS (
        UPDATE "api_key"
        SET "created_by" = @tombstone_id, "revoked_at" = COALESCE("revoked_at", @now::timestamptz)
        WHERE "api_key"."created_by" = @user_id
    ),
    audit AS (UPDATE "admin_audit" SET "admin_id" = @tombstone_id WHERE "admin_audit"."admin_id" = @user_id),
    event AS (UPDATE "calendar_event" SET "created_by" = @tombstone_id WHERE "calendar_event"."created_by" = @user_id)
SELECT 1;

-- name: DeleteCalendarAssigneesForUser :exec
-- See ReassignUserReferences' doc comment for why assignments are dropped
-- rather than tombstoned.
DELETE FROM "calendar_assignee" WHERE "user_id" = $1;

-- name: DeleteAdminUser :execrows
-- The account itself. Everything still pointing at it at this point is ON
-- DELETE CASCADE (sessions, accounts, memberships, invitations sent
-- through Limen, push subscriptions and prefs, impersonation records).
DELETE FROM "users" WHERE "id" = $1;
