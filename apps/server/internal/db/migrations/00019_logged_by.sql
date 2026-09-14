-- +goose Up

-- Who did the care versus who saved the row (spec
-- docs/superpowers/specs/2026-09-14-who-did-it-design.md). caretaker_id
-- keeps its name and now means the person who did the care — the timeline,
-- the export and the kiosk's caretaker row keep reading it. logged_by_id is
-- the session user (or the API key's owner, or the kiosk's chosen
-- caretaker) who saved the row; the server sets it and no client can.
-- Backfilled from caretaker_id: every existing row reads as "did it and
-- logged it", which is the truth as far as anyone knew.
--
-- No ON DELETE clause, like caretaker_id: account deletion re-points a
-- leaver's rows at the tombstone (admin.sql's ReassignUserReferences, which
-- TestUserDeleteCoversEveryNonCascadingUserReference checks against the
-- live schema) before the user row goes. Spelled out per table rather than
-- looped in a DO block because sqlc reads these files statically and would
-- not see the columns otherwise.

ALTER TABLE "sleep_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "sleep_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "sleep_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "feed_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "feed_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "feed_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "diaper_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "diaper_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "diaper_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "medicine_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "medicine_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "medicine_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "bath_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "bath_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "bath_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "note_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "note_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "note_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "milestone_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "milestone_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "milestone_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "measurement_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "measurement_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "measurement_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "pump_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "pump_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "pump_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "play_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "play_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "play_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "vaccine_log" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "vaccine_log" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "vaccine_log" ALTER COLUMN "logged_by_id" SET NOT NULL;

ALTER TABLE "feed_timer" ADD COLUMN "logged_by_id" text REFERENCES "users" ("id");
UPDATE "feed_timer" SET "logged_by_id" = "caretaker_id";
ALTER TABLE "feed_timer" ALTER COLUMN "logged_by_id" SET NOT NULL;

-- +goose Down

ALTER TABLE "sleep_log" DROP COLUMN "logged_by_id";
ALTER TABLE "feed_log" DROP COLUMN "logged_by_id";
ALTER TABLE "diaper_log" DROP COLUMN "logged_by_id";
ALTER TABLE "medicine_log" DROP COLUMN "logged_by_id";
ALTER TABLE "bath_log" DROP COLUMN "logged_by_id";
ALTER TABLE "note_log" DROP COLUMN "logged_by_id";
ALTER TABLE "milestone_log" DROP COLUMN "logged_by_id";
ALTER TABLE "measurement_log" DROP COLUMN "logged_by_id";
ALTER TABLE "pump_log" DROP COLUMN "logged_by_id";
ALTER TABLE "play_log" DROP COLUMN "logged_by_id";
ALTER TABLE "vaccine_log" DROP COLUMN "logged_by_id";
ALTER TABLE "feed_timer" DROP COLUMN "logged_by_id";
