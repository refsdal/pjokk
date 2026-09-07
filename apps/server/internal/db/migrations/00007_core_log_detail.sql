-- +goose Up

-- ===========================================================================
-- Detail on the three core logs (issue #43). Every column is nullable and
-- optional on the wire: the two-tap happy path never has to send any of
-- them, and rows logged before this migration simply carry NULL ("not
-- recorded"), which the SPA renders as nothing rather than as a guess.
--
--   feed_log.contents     what a bottle held: formula | breast_milk | mixed
--   feed_log.food         what a solids feed was, free text ("Banana")
--   feed_log.reaction     whether a solids feed produced a reaction; NULL is
--                         "not recorded", which is NOT the same as false
--   diaper_log.type       gains 'dry' — a checked-and-clean diaper. Counted
--                         on its own in the summary so a dry check never
--                         inflates the wet count (the sprout-track importer
--                         used to demote these to notes for exactly that
--                         reason)
--   diaper_log.color      stool colour, dirty/both only
--   diaper_log.consistency stool consistency, dirty/both only
--   sleep_log.type        nap | night. The SPA defaults it from the device's
--                         night-mode schedule; the server never guesses (it
--                         has no timezone), so API-key writes that omit it
--                         stay NULL
--
-- The enum values are CHECK constraints, matching 00001_init.sql's style
-- for feed_log.type / diaper_log.type — the spec's enum is what the SPA and
-- the request validator see, the CHECK is what a hand-written INSERT
-- (importer, psql) hits.
-- ===========================================================================
ALTER TABLE "feed_log"
    ADD COLUMN "contents" text CHECK ("contents" IN ('formula', 'breast_milk', 'mixed')),
    ADD COLUMN "food" text,
    ADD COLUMN "reaction" boolean;

-- The inline CHECK from 00001_init.sql got Postgres's default name; drop
-- and re-add under the same name so a future migration can find it again.
ALTER TABLE "diaper_log"
    DROP CONSTRAINT "diaper_log_type_check",
    ADD CONSTRAINT "diaper_log_type_check" CHECK ("type" IN ('wet', 'dirty', 'both', 'dry')),
    ADD COLUMN "color" text CHECK ("color" IN ('yellow', 'green', 'brown', 'black', 'red', 'other')),
    ADD COLUMN "consistency" text CHECK ("consistency" IN ('normal', 'loose', 'firm'));

ALTER TABLE "sleep_log"
    ADD COLUMN "type" text CHECK ("type" IN ('nap', 'night'));

-- +goose Down
ALTER TABLE "sleep_log" DROP COLUMN "type";

-- Rows the narrower constraint cannot hold have to go before it comes back;
-- a dry check is the least consequential row in the table to lose.
DELETE FROM "diaper_log" WHERE "type" = 'dry';
ALTER TABLE "diaper_log"
    DROP COLUMN "consistency",
    DROP COLUMN "color",
    DROP CONSTRAINT "diaper_log_type_check",
    ADD CONSTRAINT "diaper_log_type_check" CHECK ("type" IN ('wet', 'dirty', 'both'));

ALTER TABLE "feed_log"
    DROP COLUMN "reaction",
    DROP COLUMN "food",
    DROP COLUMN "contents";
