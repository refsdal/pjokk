-- +goose Up

-- Recurring calendar events (issue #52). A series is ONE row: occurrences
-- are expanded at read time (internal/recur), never materialised, so
-- editing the series is one write. `recurrence_until` is inclusive on the
-- occurrence's start. `reminded_at` keeps its name but, for a series, now
-- records the START of the occurrence last reminded (internal/jobs/
-- calendar_reminders.go) — "reminded_at < occurrence start" is what makes
-- the latch per occurrence.
ALTER TABLE "calendar_event"
	ADD COLUMN "recurrence" text NOT NULL DEFAULT 'none' CHECK ("recurrence" IN (
		'none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'
	)),
	ADD COLUMN "recurrence_until" timestamptz;

-- +goose Down
ALTER TABLE "calendar_event" DROP COLUMN "recurrence_until";
ALTER TABLE "calendar_event" DROP COLUMN "recurrence";
