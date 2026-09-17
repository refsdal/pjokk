-- +goose Up

-- The closing alert's latch (spec
-- docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md,
-- jobs/daycare_closing.go): "she is still there and it closes soon" is
-- said once per day at barnehage, so the latch lives on that day's row,
-- the way calendar_event.reminded_at lives on the event.
ALTER TABLE "daycare_log" ADD COLUMN "closing_alerted_at" timestamptz;

-- +goose Down
ALTER TABLE "daycare_log" DROP COLUMN "closing_alerted_at";
