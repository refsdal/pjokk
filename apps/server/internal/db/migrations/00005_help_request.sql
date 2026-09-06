-- +goose Up

-- ===========================================================================
-- Help requests between caretakers ("Ask for help").
--
-- A request is FAMILY STATE, the same way a running sleep session is: one
-- member asks a specific other member for a hand, everyone sees it on Home
-- until someone acknowledges it, the sender dismisses it when it is over.
-- The state is derived from the columns rather than an enum:
--   open          acknowledged_at IS NULL
--   acknowledged  acknowledged_at IS NOT NULL
--   stale         created_at older than two hours — filtered on READ
--                 (internal/api/summary.go), no cron needed for expiry
-- Rows are purged after seven days by the nightly job so the table stays
-- small; nothing reads them after the two-hour window.
--
-- Not baby data: no baby_id, not on the timeline, not in the CSV export.
-- It IS in the nightly backup, like every domain table.
-- ===========================================================================

CREATE TABLE "help_request" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"from_user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"to_user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	-- Free text, at most 200 characters (enforced by the OpenAPI schema).
	"message" text NOT NULL DEFAULT '',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"acknowledged_at" timestamptz,
	-- Whoever answered — any member may, not only the target. SET NULL rather
	-- than CASCADE: an acknowledged request must survive the answerer leaving.
	"acknowledged_by" text REFERENCES "users" ("id") ON DELETE SET NULL
);
-- Home reads "the newest request in this family inside the window".
CREATE INDEX "help_request_family_created_idx" ON "help_request" ("family_id", "created_at" DESC);

-- +goose Down

DROP TABLE "help_request";
