-- Queries backing internal/jobs: feed reminders,
-- calendar reminders, and the purge-orphan-users sweep.
--
-- The nightly backup itself (jobs/backup.go) is NOT here: it reads every
-- table via a raw `SELECT * FROM "<table>"` straight against the pool,
-- because the table name is a hard-coded Go slice element, not something
-- sqlc's static query analysis can parametrize.

-- Reminder queries live in queries/reminders.sql (issue #45).

-- name: LatchStaleCalendarReminders :execrows
-- Grace window: latch (without sending) any pending event whose start_time
-- is more than an hour in the past, so a long cron outage never fires a
-- stale push. $1 = now, $2 = the cutoff (now - 1h).
UPDATE "calendar_event"
SET "reminded_at" = $1
WHERE "remind_minutes_before" IS NOT NULL
  AND "recurrence" = 'none'
  AND "reminded_at" IS NULL
  AND "start_time" < $2;

-- name: ListDueCalendarReminders :many
-- Pending events whose lead time has elapsed. $1 = now - 1h (the same
-- floor LatchStaleCalendarReminders just cleared, so nothing here can ever
-- be "long past"), $2 = now (twice: once for the plain floor comparison,
-- once inside the interval arithmetic — timestamptz minus an integer is
-- not a Postgres operator, so the lead time has to be a real interval).
--
-- A SERIES (recurrence <> 'none') is a candidate whenever it has not ended
-- before the floor; which occurrence is due, and whether it was already
-- reminded (reminded_at holds the START of the last reminded occurrence),
-- is decided in Go — internal/recur does the stepping, SQL cannot.
SELECT "id", "family_id", "title", "start_time", "all_day",
       "remind_minutes_before", "reminded_at", "recurrence", "recurrence_until"
FROM "calendar_event"
WHERE "remind_minutes_before" IS NOT NULL
  AND (
    ("recurrence" = 'none'
      AND "reminded_at" IS NULL
      AND "start_time" >= $1
      AND "start_time" - ("remind_minutes_before" * interval '1 minute') <= $2)
    OR ("recurrence" <> 'none'
      AND ("recurrence_until" IS NULL OR "recurrence_until" >= $1))
  )
ORDER BY "start_time" ASC;

-- name: CalendarEventAssigneeUserIDs :many
SELECT "user_id" FROM "calendar_assignee" WHERE "event_id" = $1;

-- name: ListFamilyMemberUserIDs :many
-- The "no assignees → every family member" fallback.
SELECT "user_id" FROM "organization_members" WHERE "organization_id" = $1;

-- name: MarkCalendarEventReminded :exec
-- Latched even when every delivery failed (see calendar_reminders.go) —
-- retrying every cron tick would only hammer dead subscriptions.
UPDATE "calendar_event" SET "reminded_at" = $1 WHERE "id" = $2;

-- name: ListOrphanUsers :many
-- Accounts created past the invite flow, with no membership, past the
-- 7-day grace window, never a sysadmin, never the tombstone. Selects the id
-- ONLY — the caller must never log an email (CLAUDE.md never
-- records raw identifying data it does not need to).
SELECT u."id" FROM "users" u
WHERE (u."role" IS NULL OR u."role" != 'admin')
  AND u."id" != @tombstone_id
  AND u."created_at" < @cutoff
  AND NOT EXISTS (
    SELECT 1 FROM "organization_members" m WHERE m."user_id" = u."id"
  );

-- name: DeleteOrphanUser :execrows
-- A separate statement from admin.sql's DeleteAdminUser (same SQL): that
-- one belongs to the audited system-admin console flow, this one to an
-- unattended nightly sweep — keeping them distinct keeps each call site's
-- intent legible at the call, not just in the SQL text.
DELETE FROM "users" WHERE "id" = $1;

-- name: ListMilestonePhotoKeys :many
-- The photo backup's "live" set (jobs/photo_backup.go): the object key of
-- every photo row. Deliberately across every family, like the reminder
-- sweeps above — the nightly job serves the whole installation, and no
-- handler calls this. A stored photo object whose key is not here is an
-- orphan the job erases (issue #95). Keys only: nothing else is needed.
SELECT "object_key" FROM "milestone_photo";
