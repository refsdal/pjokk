-- +goose Up

-- Display units are a PERSON's preference (issue #53): a Norwegian
-- grandmother and an American parent share one family and each read the
-- same rows in their own units. Nothing stored changes — every value stays
-- in its canonical metric unit (DECISIONS.md 2026-09-05) and the SPA
-- converts at the edge.
ALTER TABLE "users"
	ADD COLUMN "units" text NOT NULL DEFAULT 'metric'
		CHECK ("units" IN ('metric', 'imperial'));

-- +goose Down
ALTER TABLE "users" DROP COLUMN "units";
