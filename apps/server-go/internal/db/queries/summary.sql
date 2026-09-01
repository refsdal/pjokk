-- Backs GET /api/summary (Task 11; REF §A1 sleep.ts's summary route). The
-- "last X" and "active sleep" halves of the payload reuse existing queries
-- (ListFeeds/ListDiapers with lim=1, sleep.sql's ActiveSleep/ListSleeps) —
-- see internal/api/summary.go — so this file only has the range queries the
-- `today` block needs plus GetActivePlay, which Task 11 needs ahead of
-- Task 13's play.go: play_log already exists (00001_init.sql), the routes
-- don't yet, so /api/summary reads the table directly rather than through a
-- play.go query helper that doesn't exist yet.

-- name: FeedsInRange :many
-- [from, to) — matches apps/api/src/db/scoped.ts's feedsInRange (gte/lt).
-- Named args (sqlc.arg(from_ts)/sqlc.arg(to_ts)) rather than positional $3/$4:
-- letting sqlc infer names from the compared COLUMN produced confusingly
-- backwards Go field names on SleepsInRange below (its "from" bound sits
-- next to the end_time column, and vice versa) — naming both bounds
-- explicitly keeps every range query's generated Params struct readable.
SELECT "time", "type", "amount_ml"
FROM "feed_log"
WHERE "family_id" = sqlc.arg(family_id) AND "baby_id" = sqlc.arg(baby_id)
  AND "time" >= sqlc.arg(from_ts)::timestamptz AND "time" < sqlc.arg(to_ts)::timestamptz;

-- name: DiapersInRange :many
SELECT "time", "type"
FROM "diaper_log"
WHERE "family_id" = sqlc.arg(family_id) AND "baby_id" = sqlc.arg(baby_id)
  AND "time" >= sqlc.arg(from_ts)::timestamptz AND "time" < sqlc.arg(to_ts)::timestamptz;

-- name: SleepsInRange :many
-- Sessions OVERLAPPING [from, to) — they can span midnight and the range
-- edges, so this is a range-overlap test, not a containment one. Active
-- sessions (end_time IS NULL) are treated as open-ended, matching
-- apps/api/src/db/scoped.ts's sleepsInRange.
SELECT "start_time", "end_time"
FROM "sleep_log"
WHERE "family_id" = sqlc.arg(family_id) AND "baby_id" = sqlc.arg(baby_id)
  AND "start_time" < sqlc.arg(to_ts)::timestamptz
  AND ("end_time" IS NULL OR "end_time" > sqlc.arg(from_ts)::timestamptz);

-- name: GetActivePlay :one
-- The running activity (end_time IS NULL) for a baby, if any — see this
-- file's header for why summary reads play_log directly instead of going
-- through a play.go query that Task 13 hasn't written yet.
SELECT
    p."id", p."baby_id", p."caretaker_id", COALESCE(u."name", '') AS caretaker_name,
    p."type", p."start_time", p."end_time", p."notes"
FROM "play_log" p
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
  AND (sqlc.narg(baby_id)::text IS NULL OR p."baby_id" = sqlc.narg(baby_id))
  AND p."end_time" IS NULL
ORDER BY p."start_time" DESC
LIMIT 1;
