-- +goose Up

-- The pick-up handover (issue #106, spec
-- docs/superpowers/specs/2026-09-17-daycare-handover-design.md). What the
-- staff said becomes ORDINARY rows — a nap is a sleep_log row, a meal a
-- solids feed_log row, a nappy a diaper_log row — and daycare_id is what
-- says where they came from: reported by the barnehage for that day, not
-- done by the member who typed them in (whose id the NOT NULL people
-- columns still carry). SET NULL, not CASCADE: deleting the day must not
-- delete a nap that happened.
ALTER TABLE "sleep_log" ADD COLUMN "daycare_id" text REFERENCES "daycare_log" ("id") ON DELETE SET NULL;
ALTER TABLE "feed_log" ADD COLUMN "daycare_id" text REFERENCES "daycare_log" ("id") ON DELETE SET NULL;
ALTER TABLE "diaper_log" ADD COLUMN "daycare_id" text REFERENCES "daycare_log" ("id") ON DELETE SET NULL;

-- Partial: almost every row in these tables is an ordinary one.
CREATE INDEX "sleep_daycare_idx" ON "sleep_log" ("daycare_id") WHERE "daycare_id" IS NOT NULL;
CREATE INDEX "feed_daycare_idx" ON "feed_log" ("daycare_id") WHERE "daycare_id" IS NOT NULL;
CREATE INDEX "diaper_daycare_idx" ON "diaper_log" ("daycare_id") WHERE "daycare_id" IS NOT NULL;

-- How the day went, as the staff put it.
ALTER TABLE "daycare_log" ADD COLUMN "mood" text CHECK ("mood" IN ('good', 'ok', 'hard'));

-- +goose Down
ALTER TABLE "daycare_log" DROP COLUMN "mood";
ALTER TABLE "diaper_log" DROP COLUMN "daycare_id";
ALTER TABLE "feed_log" DROP COLUMN "daycare_id";
ALTER TABLE "sleep_log" DROP COLUMN "daycare_id";
