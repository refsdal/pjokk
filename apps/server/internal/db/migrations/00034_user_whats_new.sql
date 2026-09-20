-- +goose Up

-- What's new, and a first run (spec
-- docs/superpowers/specs/2026-09-20-whats-new-and-first-run-design.md).
-- Two columns because they answer two different questions: has this person
-- ever been oriented, and how far through the release notes are they.
--
-- Both are the PERSON's, like units (00013) and language (00018): dismiss
-- on the phone and the tablet stays quiet.
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamptz;
ALTER TABLE "users" ADD COLUMN "whats_new_seq" integer NOT NULL DEFAULT 0;

-- Every account that exists today has been using the app for weeks: mark it
-- onboarded so nobody is handed a getting-started tour retroactively. The
-- mirror of 00033's backfill, which kept every existing baby's switches on.
UPDATE "users" SET "onboarded_at" = "created_at";

-- whats_new_seq needs no backfill, and that is not an oversight: the SPA
-- ships no entry older than this migration (spec, "No backlog"), so an
-- existing account has seen nothing because there is nothing to have seen.

-- +goose Down
ALTER TABLE "users" DROP COLUMN "whats_new_seq";
ALTER TABLE "users" DROP COLUMN "onboarded_at";
