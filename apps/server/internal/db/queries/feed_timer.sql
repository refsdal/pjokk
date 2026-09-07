-- Shared nursing / pump timer (issue #44; 00008_feed_timer.sql explains why
-- this is its own table rather than a feed_log row with a NULL end). Every
-- query is family-scoped (CLAUDE.md's tenancy discipline). The seconds
-- arithmetic lives in internal/api/feed_timer.go, on the server's clock:
-- these queries only read and write what it computed.

-- name: ActiveFeedTimer :one
-- COALESCE(u."display_name", '') — see feeds.sql's ListFeeds for why.
SELECT
    ft."id", ft."baby_id", ft."caretaker_id", COALESCE(u."display_name", '') AS caretaker_name,
    ft."kind", ft."start_time", ft."running_side", ft."side_started_at",
    ft."left_sec", ft."right_sec"
FROM "feed_timer" ft
JOIN "users" u ON u."id" = ft."caretaker_id"
WHERE ft."family_id" = sqlc.arg(family_id)
  AND ft."baby_id" = sqlc.arg(baby_id)
  AND ft."kind" = sqlc.arg(kind);

-- name: GetFeedTimer :one
SELECT
    ft."id", ft."baby_id", ft."caretaker_id", COALESCE(u."display_name", '') AS caretaker_name,
    ft."kind", ft."start_time", ft."running_side", ft."side_started_at",
    ft."left_sec", ft."right_sec"
FROM "feed_timer" ft
JOIN "users" u ON u."id" = ft."caretaker_id"
WHERE ft."family_id" = $1 AND ft."id" = $2;

-- name: CreateFeedTimer :one
INSERT INTO "feed_timer"
    ("family_id", "baby_id", "caretaker_id", "kind", "start_time", "running_side", "side_started_at")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: SetFeedTimerSides :execrows
-- Writes the banked seconds and the new running side together, so a
-- switch is one row version: nothing can observe "left banked, right not
-- yet started".
UPDATE "feed_timer"
SET
    "running_side" = $3,
    "side_started_at" = $4,
    "left_sec" = $5,
    "right_sec" = $6
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteFeedTimer :execrows
-- The rows-affected count is what makes a replayed stop safe: the stop
-- handler deletes inside the transaction that inserts the feed, and a zero
-- count rolls that insert back (see internal/api/feed_timer.go).
DELETE FROM "feed_timer"
WHERE "family_id" = $1 AND "id" = $2;
