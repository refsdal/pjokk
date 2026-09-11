-- Reminders (issue #45; 00009_reminders.sql). Personal rows: every caller
-- query is scoped to (user_id, family_id), and the job reads them all. The
-- "is it due" logic lives in internal/jobs/reminders.go on the server's
-- clock; these queries only read and write what it decided.

-- name: ListReminders :many
SELECT * FROM "reminder"
WHERE "user_id" = $1 AND "family_id" = $2
ORDER BY "created_at" ASC, "id" ASC;

-- name: CreateReminder :one
INSERT INTO "reminder"
    ("family_id", "user_id", "baby_id", "kind", "mode", "interval_min", "at_minute",
     "days_mask", "tz", "quiet_start", "quiet_end", "label")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: GetReminder :one
SELECT * FROM "reminder"
WHERE "id" = $1 AND "user_id" = $2 AND "family_id" = $3;

-- name: DeleteReminder :execrows
-- Scoped to the caller's own row: a reminder is a personal nag, and one
-- caretaker must not be able to silence another's by guessing an id.
DELETE FROM "reminder"
WHERE "id" = $1 AND "user_id" = $2 AND "family_id" = $3;

-- Queries below back internal/jobs/reminders.go.

-- name: ListAllReminders :many
-- Only the reminders of a current, unbanned member of the reminder's family
-- (issue #92). Removing a member deletes their reminders there
-- (auth.Service.RemoveMember); this is what keeps a row that survived some
-- other way from ever telling a former caretaker, or a banned account, how
-- long it has been since the baby ate. EXISTS rather than a JOIN, so the
-- rows stay plain reminder rows.
SELECT * FROM "reminder" r
WHERE EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "users" u ON u."id" = om."user_id"
    WHERE om."organization_id" = r."family_id"
      AND om."user_id" = r."user_id"
      AND NOT u."banned"
)
ORDER BY r."family_id", r."user_id", r."id";

-- name: SetReminderLastFired :exec
UPDATE "reminder" SET "last_fired_at" = $2 WHERE "id" = $1;

-- name: LastFeedTime :one
-- The newest log of a kind for a family, optionally one baby. NULL (an
-- aggregate NULL, not zero rows) when nothing was ever logged; the
-- ::timestamptz cast is load-bearing for codegen, as in queries/admin.sql.
SELECT MAX("time")::timestamptz AS max_time FROM "feed_log"
WHERE "family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR "baby_id" = sqlc.narg(baby_id));

-- name: LastDiaperTime :one
SELECT MAX("time")::timestamptz AS max_time FROM "diaper_log"
WHERE "family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR "baby_id" = sqlc.narg(baby_id));

-- name: LastPumpTime :one
SELECT MAX("time")::timestamptz AS max_time FROM "pump_log"
WHERE "family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR "baby_id" = sqlc.narg(baby_id));

-- name: LastMedicineTime :one
-- A medicine reminder can key on one medicine by name (case-insensitive,
-- trimmed — the sheet's free text) or on any dose at all.
SELECT MAX("time")::timestamptz AS max_time FROM "medicine_log"
WHERE "family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR "baby_id" = sqlc.narg(baby_id))
  AND (sqlc.narg(name)::text IS NULL OR lower(btrim("name")) = lower(btrim(sqlc.narg(name))));
