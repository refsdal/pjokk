-- +goose Up

-- A reminder put off by its notification's Snooze button (DECISIONS
-- 2026-09-11). The frequent job sends it again once due_at has passed — to
-- that one person, rebuilt from the reminder or calendar event as it is then
-- — and deletes the row; logging the reminder's kind after sent_at (the
-- original notification) cancels it. One row per snoozed notification.
--
-- Transient, so the nightly backup leaves the table out; the user reference
-- cascades (a person's snoozes go with their account), and a family restore
-- drops the rows of people deleted since.
CREATE TABLE "push_snooze" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"source" text NOT NULL CHECK ("source" IN ('reminder', 'calendar')),
	"source_id" text NOT NULL,
	-- A calendar reminder's occurrence start; NULL for a personal reminder.
	"occurrence_start" timestamptz,
	-- When the snoozed notification went out; due_at is 15 minutes later.
	"sent_at" timestamptz NOT NULL,
	"due_at" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "push_snooze_due_idx" ON "push_snooze" ("due_at");
CREATE INDEX "push_snooze_family_idx" ON "push_snooze" ("family_id");

-- +goose Down
DROP TABLE IF EXISTS "push_snooze";
