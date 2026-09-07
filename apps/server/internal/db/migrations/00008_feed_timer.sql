-- +goose Up

-- ===========================================================================
-- Shared nursing / pump timer (issue #44).
--
-- The nursing timer used to live in one device's localStorage: a co-parent
-- saw no running feed, a phone swap lost it, and the API could not start or
-- stop a feed the way it can a sleep. This table is the running state,
-- family-scoped like everything else, so every caretaker (and a Home
-- Assistant dashboard) sees the same clock.
--
-- Why a table of its own rather than "a feed_log row with end_time IS NULL"
-- (the sleep/play shape): a completed feed has ONE `time`, not a start and
-- an end, so a NULL end could never have meant "running" without inventing
-- an end column every finished feed would also carry. The timer is a
-- different thing from a feed — it BECOMES one on stop, in the same
-- transaction that deletes it — and its shape (a running side, banked
-- seconds per side) has nothing to do with a logged row.
--
--   kind             breast | pump; one running timer per (baby, kind), so a
--                    parent can feed one side and pump the other
--   start_time       when the timer began; becomes the feed's `time`
--   running_side     the side counting now, NULL = paused (breast only —
--                    a pump timer is one clock and is never paused, so its
--                    running_side is the side the parent chose at start)
--   side_started_at  when running_side started counting; NULL while paused
--   left_sec/right_sec  seconds banked so far; the running stretch is added
--                    on the server's clock at switch/pause/stop, never by
--                    the client, so two devices agree without a clock sync
-- ===========================================================================
CREATE TABLE "feed_timer" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"kind" text NOT NULL CHECK ("kind" IN ('breast', 'pump')),
	"start_time" timestamptz NOT NULL,
	"running_side" text CHECK ("running_side" IN ('left', 'right', 'both')),
	"side_started_at" timestamptz,
	"left_sec" integer NOT NULL DEFAULT 0,
	"right_sec" integer NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "feed_timer_one_per_baby_kind" ON "feed_timer" ("baby_id", "kind");
CREATE INDEX "feed_timer_family_idx" ON "feed_timer" ("family_id");

-- +goose Down
DROP TABLE "feed_timer";
