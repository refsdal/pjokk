-- +goose Up

-- Days at home with an ill child (issue #108, spec
-- docs/superpowers/specs/2026-09-17-illness-and-care-days-design.md):
-- Norway's «sykt barn-dager» are a yearly quota per employee, and families
-- find out in November who has used theirs. One row is one person's one
-- calendar day, whole or half.
--
-- "date" is a calendar DATE, sent by the client as its own local day: whose
-- leave it was is a fact about a day on a payslip, not an instant, and the
-- server has no timezone to derive one with.
--
-- user_id CASCADEs, unlike the log tables' caretaker columns: the row is
-- about that person's own leave, not about the child, and is theirs the way
-- a reminder is. illness_id and baby_id SET NULL — a day stays counted
-- when the illness it belonged to is deleted, and a day need not have an
-- illness at all (the child-minder was ill; the barnehage sent her home).
CREATE TABLE "care_day" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"baby_id" text REFERENCES "baby" ("id") ON DELETE SET NULL,
	"illness_id" text REFERENCES "illness" ("id") ON DELETE SET NULL,
	"date" date NOT NULL,
	"fraction" double precision NOT NULL CHECK ("fraction" IN (0.5, 1)),
	"note" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	UNIQUE ("family_id", "user_id", "date")
);
CREATE INDEX "care_day_family_date_idx" ON "care_day" ("family_id", "date");

-- Each person's own yearly number. The app states NAV's rule as reference
-- text and ships no default: entitlement depends on things it does not know
-- (how many children, sole care, a chronic illness, an employer's terms).
CREATE TABLE "care_day_quota" (
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"days" integer NOT NULL CHECK ("days" BETWEEN 0 AND 366),
	PRIMARY KEY ("family_id", "user_id")
);

-- +goose Down
DROP TABLE IF EXISTS "care_day_quota";
DROP TABLE IF EXISTS "care_day";
