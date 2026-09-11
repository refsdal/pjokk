-- +goose Up

-- One occurrence of a recurring event taken out of its series
-- (docs/superpowers/specs/2026-09-11-calendar-occurrence-exceptions-design.md).
-- Deleting "this event" writes one; editing "this event" writes one and a
-- standalone event carrying the edit. The series stays one row: the
-- expansion (internal/recur), the reminder job and the ICS feed (EXDATE)
-- leave these occurrences out. Moving the series or changing its rule
-- deletes its skips, since the occurrences they name no longer exist.
CREATE TABLE "calendar_event_skip" (
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"event_id" text NOT NULL REFERENCES "calendar_event" ("id") ON DELETE CASCADE,
	"occurrence_start" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY ("event_id", "occurrence_start")
);
CREATE INDEX "calendar_event_skip_family_idx" ON "calendar_event_skip" ("family_id");

-- +goose Down
DROP TABLE IF EXISTS "calendar_event_skip";
