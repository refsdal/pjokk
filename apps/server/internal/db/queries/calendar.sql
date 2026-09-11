-- Calendar (Task 16; REF §A1 calendar.ts). Free — no plan gate on this
-- port (the TS predecessor soft-locked creation behind premium; that gate
-- is removed here, see internal/api/calendar.go's package doc comment).
-- Babies and responsible members attach via join tables; zero baby rows =
-- family-wide event. Hydration (attaching babies/assignees to a row) is a
-- separate batched query, same shape queries/contacts.sql's
-- ContactBabiesForContacts uses.
--
-- UpdateCalendarEvent is the PATCH tri-state pattern queries/feeds.sql
-- documents in full, plus one extra always-boolean parameter:
-- clear_reminded_at, which internal/api/calendar.go sets whenever the
-- patch touches startTime or remindMinutesBefore — re-arming the reminder
-- sweep's idempotency latch (see 00001_init.sql's reminded_at column).

-- name: ListCalendarEvents :many
-- One-offs starting in [from, to), plus every SERIES that could have an
-- occurrence there (started before `to`, not ended before `from`) — the
-- occurrences themselves are expanded in Go (internal/recur), so a series
-- row comes back once and internal/api/calendar.go fans it out.
SELECT
    e."id", e."title", e."description", e."location", e."category",
    e."start_time", e."all_day", e."duration_min", e."remind_minutes_before",
    e."recurrence", e."recurrence_until",
    e."created_by", COALESCE(u."display_name", '') AS created_by_name
FROM "calendar_event" e
JOIN "users" u ON u."id" = e."created_by"
WHERE e."family_id" = sqlc.arg(family_id)
  AND (
    (e."recurrence" = 'none' AND e."start_time" >= sqlc.arg(from_time) AND e."start_time" < sqlc.arg(to_time))
    OR (e."recurrence" <> 'none' AND e."start_time" < sqlc.arg(to_time)
        AND (e."recurrence_until" IS NULL OR e."recurrence_until" >= sqlc.arg(from_time)))
  )
ORDER BY e."start_time" ASC, e."id" ASC;

-- name: ListAllCalendarEvents :many
-- Every event of the family, for the ICS feed (internal/api/ics.go), which
-- hands series to the calendar client as RRULEs rather than expanding.
SELECT
    e."id", e."title", e."description", e."location", e."category",
    e."start_time", e."all_day", e."duration_min", e."remind_minutes_before",
    e."recurrence", e."recurrence_until", e."created_at",
    e."created_by", COALESCE(u."display_name", '') AS created_by_name
FROM "calendar_event" e
JOIN "users" u ON u."id" = e."created_by"
WHERE e."family_id" = sqlc.arg(family_id)
ORDER BY e."start_time" ASC, e."id" ASC;

-- name: GetCalendarEvent :one
SELECT
    e."id", e."title", e."description", e."location", e."category",
    e."start_time", e."all_day", e."duration_min", e."remind_minutes_before",
    e."recurrence", e."recurrence_until",
    e."created_by", COALESCE(u."display_name", '') AS created_by_name
FROM "calendar_event" e
JOIN "users" u ON u."id" = e."created_by"
WHERE e."family_id" = $1 AND e."id" = $2;

-- name: CreateCalendarEvent :one
INSERT INTO "calendar_event"
    ("family_id", "created_by", "title", "description", "location",
     "category", "start_time", "all_day", "duration_min", "remind_minutes_before",
     "recurrence", "recurrence_until")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING "id";

-- name: UpdateCalendarEvent :execrows
UPDATE "calendar_event"
SET
    "title" = CASE WHEN sqlc.arg(title_set)::bool THEN sqlc.narg(title_val)::text ELSE "title" END,
    "description" = CASE WHEN sqlc.arg(description_set)::bool THEN sqlc.narg(description_val)::text ELSE "description" END,
    "location" = CASE WHEN sqlc.arg(location_set)::bool THEN sqlc.narg(location_val)::text ELSE "location" END,
    "category" = CASE WHEN sqlc.arg(category_set)::bool THEN sqlc.narg(category_val)::text ELSE "category" END,
    "start_time" = CASE WHEN sqlc.arg(start_time_set)::bool THEN sqlc.narg(start_time_val)::timestamptz ELSE "start_time" END,
    "all_day" = CASE WHEN sqlc.arg(all_day_set)::bool THEN sqlc.narg(all_day_val)::bool ELSE "all_day" END,
    "duration_min" = CASE WHEN sqlc.arg(duration_min_set)::bool THEN sqlc.narg(duration_min_val)::integer ELSE "duration_min" END,
    "remind_minutes_before" = CASE WHEN sqlc.arg(remind_minutes_before_set)::bool THEN sqlc.narg(remind_minutes_before_val)::integer ELSE "remind_minutes_before" END,
    "recurrence" = CASE WHEN sqlc.arg(recurrence_set)::bool THEN sqlc.arg(recurrence_val)::text ELSE "recurrence" END,
    "recurrence_until" = CASE WHEN sqlc.arg(recurrence_until_set)::bool THEN sqlc.narg(recurrence_until_val)::timestamptz ELSE "recurrence_until" END,
    "reminded_at" = CASE WHEN sqlc.arg(clear_reminded_at)::bool THEN NULL ELSE "reminded_at" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteCalendarEvent :execrows
DELETE FROM "calendar_event"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteCalendarEventBabies :exec
DELETE FROM "calendar_event_baby" WHERE "event_id" = $1;

-- name: CreateCalendarEventBaby :exec
INSERT INTO "calendar_event_baby" ("event_id", "baby_id") VALUES ($1, $2);

-- name: DeleteCalendarAssignees :exec
DELETE FROM "calendar_assignee" WHERE "event_id" = $1;

-- name: CreateCalendarAssignee :exec
INSERT INTO "calendar_assignee" ("event_id", "user_id") VALUES ($1, $2);

-- name: CalendarEventBabiesForEvents :many
-- Hydration for ListCalendarEvents (many events) — one batched query keyed
-- by ANY(event_ids), grouped client-side in internal/api/calendar.go.
SELECT ceb."event_id", b."id", b."name"
FROM "calendar_event_baby" ceb
JOIN "baby" b ON b."id" = ceb."baby_id"
WHERE ceb."event_id" = ANY(sqlc.slice(event_ids))
ORDER BY b."name";

-- name: CalendarEventBabiesForEvent :many
-- Hydration for GetCalendarEvent/CreateCalendarEvent/UpdateCalendarEvent
-- (one event).
SELECT b."id", b."name"
FROM "calendar_event_baby" ceb
JOIN "baby" b ON b."id" = ceb."baby_id"
WHERE ceb."event_id" = $1
ORDER BY b."name";

-- name: CalendarAssigneesForEvents :many
SELECT ca."event_id", u."id" AS user_id, COALESCE(u."display_name", '') AS name
FROM "calendar_assignee" ca
JOIN "users" u ON u."id" = ca."user_id"
WHERE ca."event_id" = ANY(sqlc.slice(event_ids))
ORDER BY u."display_name";

-- name: CalendarAssigneesForEvent :many
SELECT u."id" AS user_id, COALESCE(u."display_name", '') AS name
FROM "calendar_assignee" ca
JOIN "users" u ON u."id" = ca."user_id"
WHERE ca."event_id" = $1
ORDER BY u."display_name";

-- Skips: one occurrence taken out of a series (00016_calendar_event_skip.sql).

-- name: CreateCalendarEventSkip :exec
-- Skipping an occurrence twice is one skip.
INSERT INTO "calendar_event_skip" ("family_id", "event_id", "occurrence_start")
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: CalendarEventSkipsForEvents :many
-- Batched for the list and the ICS feed, like the link hydration above.
SELECT "event_id", "occurrence_start"
FROM "calendar_event_skip"
WHERE "family_id" = sqlc.arg(family_id) AND "event_id" = ANY(sqlc.arg(event_ids)::text[]);

-- name: CalendarEventSkipsForEvent :many
SELECT "occurrence_start"
FROM "calendar_event_skip"
WHERE "family_id" = $1 AND "event_id" = $2;

-- name: DeleteCalendarEventSkips :exec
DELETE FROM "calendar_event_skip" WHERE "family_id" = $1 AND "event_id" = $2;
