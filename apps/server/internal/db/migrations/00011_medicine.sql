-- +goose Up

-- ===========================================================================
-- The family's medicine catalogue (issue #49). A dose used to be a free-text
-- name typed every time; the app could not say at 02:00 whether the next
-- paracetamol was allowed yet. This table is what a family knows about the
-- medicines it gives — the name, the usual dose, and how long to wait —
-- entered by the family, never shipped by the app (no dosing tables: that
-- is the pharmacist's leaflet, not the app's business).
--
--   default_amount / unit  what the log sheet prefills when the chip is
--                          picked; NULL = no prefill
--   min_interval_min       the family's own "at most every N hours"; the
--                          sheet and the timeline show "next dose OK from
--                          HH:MM" from it and never block a save — the
--                          parent is the authority, not the app
--   is_supplement          vitamin D and the like: shown, never warned about
--   archived_at            hidden from the chips, kept for old doses
--
-- medicine_log.medicine_id links a dose to its catalogue entry; NULL for
-- free-text and imported doses, and ON DELETE SET NULL so deleting an entry
-- leaves every dose with its name.
-- ===========================================================================
CREATE TABLE "medicine" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"default_amount" double precision,
	"unit" text CHECK ("unit" IN ('ml', 'mg', 'drops', 'dose')),
	"min_interval_min" integer CHECK ("min_interval_min" > 0),
	"is_supplement" boolean NOT NULL DEFAULT false,
	"archived_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "medicine_family_idx" ON "medicine" ("family_id");

ALTER TABLE "medicine_log"
	ADD COLUMN "medicine_id" text REFERENCES "medicine" ("id") ON DELETE SET NULL;
CREATE INDEX "medicine_log_medicine_idx" ON "medicine_log" ("medicine_id");

-- +goose Down
ALTER TABLE "medicine_log" DROP COLUMN "medicine_id";
DROP TABLE "medicine";
