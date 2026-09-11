-- Snoozed reminders (00017_push_snooze.sql): written by POST
-- /api/push/snooze, read and deleted by internal/jobs/snooze.go.

-- name: DeletePushSnoozesFor :exec
-- A second tap on the same notification (or its twin on another device)
-- replaces the first snooze rather than adding one.
DELETE FROM "push_snooze"
WHERE "family_id" = $1 AND "user_id" = $2 AND "source" = $3 AND "source_id" = $4
  AND "occurrence_start" IS NOT DISTINCT FROM $5;

-- name: CreatePushSnooze :exec
INSERT INTO "push_snooze"
    ("family_id", "user_id", "source", "source_id", "occurrence_start", "sent_at", "due_at")
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListDuePushSnoozes :many
-- The job's read, across families like ListAllReminders.
SELECT * FROM "push_snooze" WHERE "due_at" <= $1 ORDER BY "due_at", "id";

-- name: DeletePushSnooze :exec
DELETE FROM "push_snooze" WHERE "id" = $1;
