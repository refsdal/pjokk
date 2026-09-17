-- +goose Up

-- One row per day at barnehage, from drop-off to pick-up (issue #105, spec
-- docs/superpowers/specs/2026-09-17-daycare-session-design.md). A sleep_log
-- clone in the way play_log is: end_time IS NULL means she is there now,
-- and the partial unique index makes "one running session per baby" the
-- database's rule rather than a handler's.
--
-- Two people belong to a day there, so the row carries two: caretaker_id
-- dropped off (the who-did-it rule, 00019), pickup_caretaker_id picked up.
-- NULL on a finished row means "not recorded", never the drop-off person.
CREATE TABLE "daycare_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"logged_by_id" text NOT NULL REFERENCES "users" ("id"),
	"pickup_caretaker_id" text REFERENCES "users" ("id"),
	"start_time" timestamptz NOT NULL,
	"end_time" timestamptz,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "daycare_family_start_idx" ON "daycare_log" ("family_id", "start_time");
CREATE INDEX "daycare_baby_idx" ON "daycare_log" ("baby_id");
CREATE UNIQUE INDEX "daycare_one_active_per_baby" ON "daycare_log" ("baby_id") WHERE "end_time" IS NULL;

-- +goose Down
DROP TABLE IF EXISTS "daycare_log";
