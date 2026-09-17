-- +goose Up

-- Barnehage on the calendar (issue #110): planning days, parent meetings,
-- photo day and summer closure all landed in "other", and a closed day was
-- discovered at the gate. A category of its own, and a flag for the days it
-- is closed — the one fact about such an event that changes a family's
-- morning, which Home surfaces the evening before.
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_category_check";
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_category_check"
	CHECK ("category" IN ('doctor', 'vaccination', 'babysitting', 'family', 'daycare', 'other'));
ALTER TABLE "calendar_event" ADD COLUMN "closed" boolean NOT NULL DEFAULT false;

-- +goose Down
UPDATE "calendar_event" SET "category" = 'other' WHERE "category" = 'daycare';
ALTER TABLE "calendar_event" DROP COLUMN "closed";
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_category_check";
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_category_check"
	CHECK ("category" IN ('doctor', 'vaccination', 'babysitting', 'family', 'other'));
