-- Queries backing internal/jobs (Task 23; REF §A7): feed reminders,
-- calendar reminders, and the purge-orphan-users sweep.
--
-- The nightly backup itself (jobs/backup.go) is NOT here: it reads every
-- table via a raw `SELECT * FROM "<table>"` straight against the pool,
-- because the table name is a hard-coded Go slice element, not something
-- sqlc's static query analysis can parametrize.

-- name: ListFeedReminderPrefs :many
-- Every push_pref row with a non-zero threshold — feed_reminder_hours=0 is
-- "off", the default apps/api/src/routes/push.ts's PushPrefsSchema (and its
-- Go port's UpsertPushPref) leaves untouched.
SELECT * FROM "push_pref"
WHERE "feed_reminder_hours" > 0;

-- name: MaxFeedTimeForFamily :one
-- The family's most recent feed, family-wide (not per baby) — matches
-- apps/api/src/jobs/reminders.ts's single max(feedLog.time) query. NULL
-- (an aggregate NULL, not zero rows) when the family has never logged a
-- feed; the ::timestamptz cast is load-bearing for codegen the same way
-- ListAdminFamilies' last_feed_at needs it (queries/admin.sql).
SELECT MAX("time")::timestamptz AS max_time FROM "feed_log" WHERE "family_id" = $1;

-- name: SetPushPrefLastReminded :exec
-- Stamps the idempotency latch after a reminder fires. Unlike
-- UpsertPushPref (a caller's own preference write), this never touches
-- feed_reminder_hours.
UPDATE "push_pref"
SET "last_reminded_at" = $1
WHERE "user_id" = $2 AND "family_id" = $3;

-- name: LatchStaleCalendarReminders :execrows
-- Grace window: latch (without sending) any pending event whose start_time
-- is more than an hour in the past, so a long cron outage never fires a
-- stale push. $1 = now, $2 = the cutoff (now - 1h).
UPDATE "calendar_event"
SET "reminded_at" = $1
WHERE "remind_minutes_before" IS NOT NULL
  AND "reminded_at" IS NULL
  AND "start_time" < $2;

-- name: ListDueCalendarReminders :many
-- Pending events whose lead time has elapsed. $1 = now - 1h (the same
-- floor LatchStaleCalendarReminders just cleared, so nothing here can ever
-- be "long past"), $2 = now (twice: once for the plain floor comparison,
-- once inside the interval arithmetic — timestamptz minus an integer is
-- not a Postgres operator, so the lead time has to be a real interval).
SELECT "id", "family_id", "title", "start_time", "all_day"
FROM "calendar_event"
WHERE "remind_minutes_before" IS NOT NULL
  AND "reminded_at" IS NULL
  AND "start_time" >= $1
  AND "start_time" - ("remind_minutes_before" * interval '1 minute') <= $2
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
-- ONLY — the caller must never log an email (REF §A7; CLAUDE.md never
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
