-- Queries backing kiosk devices (docs/superpowers/specs/
-- 2026-09-10-kiosk-devices-design.md): the family-admin management surface,
-- enrolment, and the device's own reads.
--
-- Every query here takes family_id EXCEPT two, which cannot know it and are
-- the same deliberate exception as GetAPIKeyByHash: EnrolDevice (the tablet
-- holds nothing but the one-time code) and GetDeviceByTokenHash (the
-- per-request credential lookup).

-- name: CreateDevice :one
-- A pending device: the code's SHA-256 and expiry, no token yet.
INSERT INTO "device" ("family_id", "name", "created_by", "enrol_code_hash", "enrol_expires_at")
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: CountActiveDevices :one
-- Pending and active devices count against the per-family cap; revoked ones
-- do not.
SELECT COUNT(*)::int FROM "device" WHERE "family_id" = $1 AND "revoked_at" IS NULL;

-- name: ListDevices :many
-- Pending and active devices, newest first. Revoked rows are kept (their
-- history is the row) but never listed: there is nothing left to do with one.
SELECT d.*, COALESCE(u."display_name", u."name", '')::text AS created_by_name
FROM "device" d
JOIN "users" u ON u."id" = d."created_by"
WHERE d."family_id" = $1 AND d."revoked_at" IS NULL
ORDER BY d."created_at" DESC;

-- name: GetDevice :one
-- The same shape as ListDevices' rows (so the handler converts one to the
-- other), for the create and renew responses.
SELECT d.*, COALESCE(u."display_name", u."name", '')::text AS created_by_name
FROM "device" d
JOIN "users" u ON u."id" = d."created_by"
WHERE d."id" = $1 AND d."family_id" = $2;

-- name: RenewDeviceCode :execrows
-- A new code for a device still waiting to be set up. Zero rows means
-- unknown, revoked, or already enrolled — the handler tells them apart.
UPDATE "device" SET "enrol_code_hash" = $3, "enrol_expires_at" = $4
WHERE "id" = $1 AND "family_id" = $2 AND "token_hash" IS NULL AND "revoked_at" IS NULL;

-- name: RevokeDevice :execrows
-- Soft-delete, like RevokeAPIKey: GetDeviceByTokenHash filters revoked rows,
-- so the tablet's cookie stops working on its next request. Revoking twice
-- affects zero rows (reported as 404, same as an unknown id).
UPDATE "device" SET "revoked_at" = $3
WHERE "id" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;

-- name: EnrolDevice :one
-- Redeem a one-time code. Cross-family by nature (see the header). ONE
-- statement both checks and consumes the code, so there is no read-then-write
-- window: a second use, an expired code and a device revoked while pending
-- all match zero rows, and two tablets racing the same code cannot both win.
WITH d AS (
    UPDATE "device"
    SET "token_hash" = @token_hash, "pin_hash" = @pin_hash, "enrolled_at" = @now::timestamptz,
        "last_used_at" = @now::timestamptz, "enrol_code_hash" = NULL, "enrol_expires_at" = NULL
    WHERE "enrol_code_hash" = @code_hash AND "enrol_expires_at" > @now::timestamptz
      AND "token_hash" IS NULL AND "revoked_at" IS NULL
    RETURNING "id", "family_id", "name"
)
SELECT d."id", d."family_id", d."name", o."name" AS family_name
FROM d
JOIN "organizations" o ON o."id" = d."family_id";

-- name: GetDeviceByTokenHash :one
-- The per-request credential lookup (middleware.DeviceAuth). Cross-family by
-- nature (see the header). A revoked device is indistinguishable from one
-- that never existed; a deleted family takes its devices with it.
SELECT d."id", d."family_id", d."name", o."name" AS family_name, d."last_used_at"
FROM "device" d
JOIN "organizations" o ON o."id" = d."family_id"
WHERE d."token_hash" = $1 AND d."revoked_at" IS NULL;

-- name: TouchDevice :exec
-- Coarse last-used tracking, at most once per five minutes per device.
UPDATE "device" SET "last_used_at" = $2 WHERE "id" = $1;

-- name: GetDevicePinHash :one
SELECT COALESCE("pin_hash", '')::text AS pin_hash
FROM "device"
WHERE "id" = $1 AND "family_id" = $2 AND "revoked_at" IS NULL;

-- name: ListFamilyReminderThresholds :many
-- The kiosk's amber card (spec §5): every caretaker's since_last feed/diaper
-- interval in the family — nothing else about anyone's reminders.
SELECT DISTINCT "kind", "baby_id", "interval_min"::int AS interval_min
FROM "reminder"
WHERE "family_id" = $1 AND "mode" = 'since_last' AND "kind" IN ('feed', 'diaper')
ORDER BY "kind", interval_min;
