-- +goose Up

-- An illness episode (issue #107, spec
-- docs/superpowers/specs/2026-09-17-illness-and-care-days-design.md): what
-- ties Monday's fever to Tuesday's vomiting, and what the "symptom-free
-- since" clock counts from. State like a sleep session — end_time IS NULL
-- means she is still ill, one open episode per baby by partial unique
-- index.
--
-- The app ships no medical judgement. clear_hours is the FAMILY's number
-- for THIS episode (the sheet suggests 48 for vomiting or diarrhoea, FHI's
-- guidance, and nothing otherwise); last_symptom_at is what they told us.
-- The server compares neither to anything.
CREATE TABLE "illness" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"logged_by_id" text NOT NULL REFERENCES "users" ("id"),
	"start_time" timestamptz NOT NULL,
	"end_time" timestamptz,
	"symptoms" text[] NOT NULL DEFAULT '{}'
		CHECK ("symptoms" <@ ARRAY['fever', 'vomiting', 'diarrhoea', 'cough', 'cold', 'rash', 'eye', 'ear', 'other']::text[]),
	-- NULL = still having symptoms (or never said otherwise).
	"last_symptom_at" timestamptz,
	"clear_hours" integer CHECK ("clear_hours" BETWEEN 1 AND 240),
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "illness_family_start_idx" ON "illness" ("family_id", "start_time");
CREATE INDEX "illness_baby_idx" ON "illness" ("baby_id");
CREATE UNIQUE INDEX "illness_one_open_per_baby" ON "illness" ("baby_id") WHERE "end_time" IS NULL;

-- +goose Down
DROP TABLE IF EXISTS "illness";
