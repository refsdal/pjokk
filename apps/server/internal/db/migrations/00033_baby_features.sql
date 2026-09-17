-- +goose Up

-- What the family tracks for this baby (spec
-- docs/superpowers/specs/2026-09-17-per-baby-tracking-design.md): the
-- ENABLED keys of the thirteen per-baby switches. A column rather than a
-- table because a switch set is a set: it rides with the baby, needs no
-- restore or backup rule of its own, and is replaced whole. A switch that
-- is off hides a feature's entry points in the app and holds its
-- reminders (internal/jobs); the server still accepts every write.
ALTER TABLE "baby" ADD COLUMN "features" text[] NOT NULL DEFAULT '{}';

-- Every baby that exists today keeps everything: nobody's app changes on
-- upgrade. A baby created from now on starts empty and chooses on the
-- carousel. The list is api.AllFeatures, in the spec's order.
UPDATE "baby" SET "features" = ARRAY[
  'feeds', 'pump', 'sleep', 'diapers', 'medicine', 'measurements',
  'milestones', 'bath', 'notes', 'play', 'daycare', 'illness', 'vaccines'
];

-- +goose Down
ALTER TABLE "baby" DROP COLUMN "features";
