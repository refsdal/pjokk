-- +goose Up

-- The barnehage as a place (spec
-- docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
-- daycare_log says WHERE she is; this says what the place is: how to reach
-- it and when it closes. Not a `contact` row: hours, a zone and a per-baby
-- link are not address-book fields, and nothing reads contacts.
--
-- open_minute / close_minute are minutes after LOCAL midnight, one pair for
-- every weekday. "Closes 16:30" is a wall-clock fact and the server has no
-- timezone, so the row carries the IANA zone of the device that created it,
-- exactly as a reminder does. alert_lead_min is the FAMILY's number for the
-- closing alert (jobs/daycare_closing.go); NULL means no alert.
CREATE TABLE "daycare_place" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"notes" text,
	"open_minute" integer CHECK ("open_minute" BETWEEN 0 AND 1439),
	"close_minute" integer CHECK ("close_minute" BETWEEN 0 AND 1439),
	"alert_lead_min" integer CHECK ("alert_lead_min" BETWEEN 5 AND 180),
	"tz" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "daycare_place_family_idx" ON "daycare_place" ("family_id");

-- Which baby goes where. The primary key IS the baby: one place at a time,
-- so enrolling her somewhere else is an upsert, and siblings can differ.
CREATE TABLE "daycare_enrolment" (
	"baby_id" text PRIMARY KEY REFERENCES "baby" ("id") ON DELETE CASCADE,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"place_id" text NOT NULL REFERENCES "daycare_place" ("id") ON DELETE CASCADE
);
CREATE INDEX "daycare_enrolment_place_idx" ON "daycare_enrolment" ("place_id");

-- +goose Down
DROP TABLE IF EXISTS "daycare_enrolment";
DROP TABLE IF EXISTS "daycare_place";
