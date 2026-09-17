-- The barnehage as a place, who collects her and when (spec
-- docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
-- Family-scoped like every domain table. The closing alert's own queries
-- sweep every family and live at the bottom, as reminders.sql's do.

-- name: ListDaycarePlaces :many
SELECT "id", "name", "address", "phone", "email", "website", "notes",
       "open_minute", "close_minute", "alert_lead_min", "tz"
FROM "daycare_place"
WHERE "family_id" = $1
ORDER BY "name", "id";

-- name: GetDaycarePlace :one
SELECT "id", "name", "address", "phone", "email", "website", "notes",
       "open_minute", "close_minute", "alert_lead_min", "tz"
FROM "daycare_place"
WHERE "family_id" = $1 AND "id" = $2;

-- name: CreateDaycarePlace :one
INSERT INTO "daycare_place"
    ("family_id", "name", "address", "phone", "email", "website", "notes",
     "open_minute", "close_minute", "alert_lead_min", "tz")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING "id";

-- name: UpdateDaycarePlace :execrows
-- A full-row write: the route is a PUT, and the settings page holds every
-- field, so there is no omitted-versus-null to tell apart.
UPDATE "daycare_place"
SET "name" = $3, "address" = $4, "phone" = $5, "email" = $6, "website" = $7,
    "notes" = $8, "open_minute" = $9, "close_minute" = $10,
    "alert_lead_min" = $11, "tz" = $12
WHERE "family_id" = $1 AND "id" = $2;

-- name: DeleteDaycarePlace :execrows
DELETE FROM "daycare_place"
WHERE "family_id" = $1 AND "id" = $2;

-- name: DaycareEnrolmentsForFamily :many
SELECT e."place_id", e."baby_id"
FROM "daycare_enrolment" e
JOIN "baby" b ON b."id" = e."baby_id"
WHERE e."family_id" = $1
ORDER BY b."name", b."id";

-- name: DeleteDaycareEnrolmentsForPlace :exec
DELETE FROM "daycare_enrolment"
WHERE "family_id" = $1 AND "place_id" = $2;

-- name: UpsertDaycareEnrolment :exec
-- The primary key is the baby, so enrolling her here moves her from
-- anywhere else. The DO UPDATE is family-guarded: the handler has already
-- checked the baby is this family's, and this keeps the scope in the SQL.
INSERT INTO "daycare_enrolment" ("baby_id", "family_id", "place_id")
VALUES ($1, $2, $3)
ON CONFLICT ("baby_id") DO UPDATE SET "place_id" = EXCLUDED."place_id"
WHERE "daycare_enrolment"."family_id" = EXCLUDED."family_id";

-- name: GetDaycarePlaceForBaby :one
SELECT p."id", p."name", p."address", p."phone", p."email", p."website", p."notes",
       p."open_minute", p."close_minute", p."alert_lead_min", p."tz"
FROM "daycare_enrolment" e
JOIN "daycare_place" p ON p."id" = e."place_id"
WHERE e."family_id" = $1 AND e."baby_id" = $2;

-- name: ListPickupPlan :many
SELECT "weekday", "pickup_minute", "user_id"
FROM "daycare_pickup_plan"
WHERE "family_id" = $1 AND "baby_id" = $2
ORDER BY "weekday";

-- name: DeletePickupPlan :exec
DELETE FROM "daycare_pickup_plan"
WHERE "family_id" = $1 AND "baby_id" = $2;

-- name: CreatePickupPlanDay :exec
INSERT INTO "daycare_pickup_plan" ("family_id", "baby_id", "weekday", "pickup_minute", "user_id")
VALUES ($1, $2, $3, $4, $5);

-- name: ListPickupOverridesFrom :many
SELECT "date", "user_id"
FROM "daycare_pickup_override"
WHERE "family_id" = $1 AND "baby_id" = $2 AND "date" >= sqlc.arg(from_date)::date
ORDER BY "date";

-- name: UpsertPickupOverride :exec
INSERT INTO "daycare_pickup_override" ("family_id", "baby_id", "date", "user_id")
VALUES ($1, $2, $3, $4)
ON CONFLICT ("baby_id", "date") DO UPDATE SET "user_id" = EXCLUDED."user_id"
WHERE "daycare_pickup_override"."family_id" = EXCLUDED."family_id";

-- name: DeletePickupOverride :exec
DELETE FROM "daycare_pickup_override"
WHERE "family_id" = $1 AND "baby_id" = $2 AND "date" = $3;
