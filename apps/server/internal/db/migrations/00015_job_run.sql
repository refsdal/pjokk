-- +goose Up

-- Every run of a scheduled job, wherever it ran
-- (docs/superpowers/specs/2026-09-11-admin-ops-design.md §1). In a split
-- deployment the process answering /admin is not the one running the jobs —
-- a `worker` replica or Kubernetes CronJobs are — so "did last night's
-- backup happen" can only be answered from here, never from memory.
--
-- No user column: who pressed Run now is in admin_audit (`job.run`). That
-- keeps this table out of ReassignUserReferences. It is bookkeeping, not
-- data, so the nightly backup leaves it out (jobs.DeliberatelyExcluded) and
-- the nightly job prunes it after 30 days.
CREATE TABLE "job_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"job" text NOT NULL,
	"trigger" text NOT NULL CHECK ("trigger" IN ('schedule', 'cli', 'console')),
	"started_at" timestamptz NOT NULL DEFAULT now(),
	"finished_at" timestamptz,
	"ok" boolean,
	"error" text,
	-- A run is either still going (neither set) or over (both set).
	CONSTRAINT "job_run_finished" CHECK (("finished_at" IS NULL) = ("ok" IS NULL))
);
CREATE INDEX "job_run_job_idx" ON "job_run" ("job", "started_at" DESC);

-- +goose Down
DROP TABLE IF EXISTS "job_run";
