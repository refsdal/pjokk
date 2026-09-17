-- +goose Up

-- Who collects her, and when (same spec as 00029). The owner's answer was
-- "mostly a fixed weekly pattern", so the plan is a Monday-to-Friday grid
-- per baby rather than calendar events: weekday is ISO (1 = Monday), and a
-- row holds an expected time, a person, or both. The time is display only —
-- a plan, not a deadline; nothing fires on it.
--
-- user_id SETs NULL: the day keeps its time when the account goes, and a
-- person who is no longer a member reads as nobody wherever it is resolved
-- (RemoveMember clears them too, auth.sql).
CREATE TABLE "daycare_pickup_plan" (
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"weekday" integer NOT NULL CHECK ("weekday" BETWEEN 1 AND 5),
	"pickup_minute" integer CHECK ("pickup_minute" BETWEEN 0 AND 1439),
	"user_id" text REFERENCES "users" ("id") ON DELETE SET NULL,
	PRIMARY KEY ("baby_id", "weekday")
);
CREATE INDEX "daycare_pickup_plan_family_idx" ON "daycare_pickup_plan" ("family_id");

-- The exception: someone else collects on one day. "date" is a calendar
-- DATE sent by the client as its own local day, the care_day rule. The row
-- is nothing without its person, so user_id CASCADEs (and the table is
-- userOwned in internal/restore).
CREATE TABLE "daycare_pickup_override" (
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"date" date NOT NULL,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	PRIMARY KEY ("baby_id", "date")
);
CREATE INDEX "daycare_pickup_override_family_idx" ON "daycare_pickup_override" ("family_id");

-- +goose Down
DROP TABLE IF EXISTS "daycare_pickup_override";
DROP TABLE IF EXISTS "daycare_pickup_plan";
