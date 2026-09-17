-- +goose Up

-- How much of a meal she ate (issue #113): what a barnehage reports, and
-- what a parent knows about a toddler's lunch that nobody weighed. Optional
-- detail like contents / food / reaction (00008): NULL is "not recorded",
-- and the two-tap happy path never sends it. Only meaningful for solids.
ALTER TABLE "feed_log" ADD COLUMN "appetite" text
	CHECK ("appetite" IN ('well', 'some', 'little'));

-- +goose Down
ALTER TABLE "feed_log" DROP COLUMN "appetite";
