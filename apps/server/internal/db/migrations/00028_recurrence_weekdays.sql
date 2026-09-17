-- +goose Up

-- A "weekdays" recurrence, Monday to Friday (issue #125): the pick-up rota,
-- which is none of daily / weekly / biweekly / monthly / yearly. The
-- stepping lives in internal/recur like every other rule; this only lets
-- the column hold the word.
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_recurrence_check";
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_recurrence_check"
	CHECK ("recurrence" IN ('none', 'daily', 'weekly', 'biweekly', 'weekdays', 'monthly', 'yearly'));

-- +goose Down
UPDATE "calendar_event" SET "recurrence" = 'weekly' WHERE "recurrence" = 'weekdays';
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_recurrence_check";
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_recurrence_check"
	CHECK ("recurrence" IN ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'));
