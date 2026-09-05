-- +goose Up

-- ===========================================================================
-- Temperature as a fourth measurement type.
--
-- A temperature is the same shape as the three growth measures already here —
-- a number with a unit, at a moment, optionally annotated — so it is a fourth
-- `type` rather than a table of its own. That inherits the whole existing
-- path (the shared CRUD engine, the log sheet, timeline rows, CSV export,
-- the nightly backup) for the cost of one constraint.
--
-- The value stays in the CANONICAL unit, °C, exactly as weight stays in kg
-- and length in cm: `measurement_log` has no unit column, and the unit is a
-- pure function of `type` resolved at the render sites. That is deliberate.
-- It means adding Fahrenheit later is a formatter plus a user preference,
-- touching no rows and no schema.
--
-- Nothing that reads growth data needs changing: the growth chart and the
-- stats weight row both filter `type = 'weight'` already, so a temperature
-- cannot reach the WHO percentile maths.
-- ===========================================================================

ALTER TABLE "measurement_log" DROP CONSTRAINT "measurement_log_type_check";
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_type_check"
	CHECK ("type" IN ('weight', 'length', 'head', 'temperature'));

-- +goose Down

-- Temperatures have no home under the old constraint, so they go rather than
-- block the rollback. A down-migration that cannot run is not a rollback.
DELETE FROM "measurement_log" WHERE "type" = 'temperature';
ALTER TABLE "measurement_log" DROP CONSTRAINT "measurement_log_type_check";
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_type_check"
	CHECK ("type" IN ('weight', 'length', 'head'));
