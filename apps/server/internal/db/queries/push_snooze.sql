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

-- name: DeleteUndeliverablePushSnoozes :execrows
-- Spends every due snooze whose person is no longer a member of its family,
-- or is banned (issue #92), before the job reads the rest. Dropped rather
-- than skipped: a snooze is one shot, and one kept past a ban or a removal
-- would come back as a stale notification after an unban or a re-invite.
DELETE FROM "push_snooze" s
WHERE s."due_at" <= $1
  AND NOT EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "users" u ON u."id" = om."user_id"
    WHERE om."organization_id" = s."family_id"
      AND om."user_id" = s."user_id"
      AND NOT u."banned"
  );

-- name: ListDuePushSnoozes :many
-- The job's read, across families like ListAllReminders, and filtered the
-- same way: only a current, unbanned member's snoozes. The prune above
-- already removed the rest; this keeps a membership that ends between the
-- two statements from delivering.
SELECT * FROM "push_snooze" s
WHERE s."due_at" <= $1
  AND EXISTS (
    SELECT 1 FROM "organization_members" om
    JOIN "users" u ON u."id" = om."user_id"
    WHERE om."organization_id" = s."family_id"
      AND om."user_id" = s."user_id"
      AND NOT u."banned"
  )
ORDER BY s."due_at", s."id";

-- name: DeletePushSnooze :exec
DELETE FROM "push_snooze" WHERE "id" = $1;
