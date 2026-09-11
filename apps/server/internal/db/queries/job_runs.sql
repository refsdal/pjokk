-- Job runs (docs/superpowers/specs/2026-09-11-admin-ops-design.md §1):
-- written by cron.Start for every run, read by the console's Ops page.

-- name: InsertJobRun :one
INSERT INTO "job_run" ("job", "trigger", "started_at")
VALUES ($1, $2, $3)
RETURNING "id";

-- name: FinishJobRun :exec
UPDATE "job_run"
SET "finished_at" = $2, "ok" = $3, "error" = $4
WHERE "id" = $1;

-- name: ListJobRuns :many
-- The newest runs of one job, for the Ops page.
SELECT "id", "job", "trigger", "started_at", "finished_at", "ok", "error"
FROM "job_run"
WHERE "job" = $1
ORDER BY "started_at" DESC, "id" DESC
LIMIT $2;

-- name: LastJobSuccess :one
-- When the job last finished without an error. No row when it never has.
SELECT "finished_at"
FROM "job_run"
WHERE "job" = $1 AND "ok"
ORDER BY "finished_at" DESC
LIMIT 1;

-- name: PruneJobRuns :execrows
DELETE FROM "job_run" WHERE "started_at" < $1;

-- name: DeleteJobRun :exec
-- A claim given back before it ran (its audit row could not be written):
-- no run happened, so no row either.
DELETE FROM "job_run" WHERE "id" = $1;
