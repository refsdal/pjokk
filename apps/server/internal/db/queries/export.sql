-- CSV export (Task 17; REF §A1 export.ts). Every query here is
-- family-scoped ONLY — no baby_id filter, unlike every List query above:
-- the export covers every baby in the family in one file, exactly like
-- apps/api/src/routes/export.ts's fam.listFeeds({limit: MAX}) (no babyId in
-- opts). Ordered ASCENDING by the kind's natural timestamp (time, or
-- start_time for the two session tables — sleep, play) with "id" as a
-- tiebreaker for deterministic output, and capped at sqlc.arg(lim) — Go's
-- exportMaxRows (internal/api/export.go) passes 100_000, matching the TS
-- predecessor's MAX per kind.
--
-- baby_name is joined directly (INNER JOIN "baby") rather than hydrated via
-- a separate id->name map the way export.ts's babyName Map does it: every
-- log row's baby_id is FK-guaranteed (ON DELETE CASCADE) to resolve, so the
-- join can never silently drop a row.

-- name: ExportFeeds :many
SELECT
    f."baby_id", bb."name" AS baby_name, f."time", f."type", f."amount_ml",
    f."side", f."duration_min", COALESCE(u."name", '') AS caretaker_name, f."notes"
FROM "feed_log" f
JOIN "baby" bb ON bb."id" = f."baby_id"
JOIN "users" u ON u."id" = f."caretaker_id"
WHERE f."family_id" = sqlc.arg(family_id)
ORDER BY f."time" ASC, f."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportDiapers :many
SELECT
    d."baby_id", bb."name" AS baby_name, d."time", d."type",
    COALESCE(u."name", '') AS caretaker_name, d."notes"
FROM "diaper_log" d
JOIN "baby" bb ON bb."id" = d."baby_id"
JOIN "users" u ON u."id" = d."caretaker_id"
WHERE d."family_id" = sqlc.arg(family_id)
ORDER BY d."time" ASC, d."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportSleeps :many
SELECT
    s."baby_id", bb."name" AS baby_name, s."start_time", s."end_time",
    s."location", COALESCE(u."name", '') AS caretaker_name, s."notes"
FROM "sleep_log" s
JOIN "baby" bb ON bb."id" = s."baby_id"
JOIN "users" u ON u."id" = s."caretaker_id"
WHERE s."family_id" = sqlc.arg(family_id)
ORDER BY s."start_time" ASC, s."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportMedicine :many
SELECT
    m."baby_id", bb."name" AS baby_name, m."time", m."name", m."amount", m."unit",
    COALESCE(u."name", '') AS caretaker_name, m."notes"
FROM "medicine_log" m
JOIN "baby" bb ON bb."id" = m."baby_id"
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
ORDER BY m."time" ASC, m."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportBaths :many
SELECT
    b."baby_id", bb."name" AS baby_name, b."time",
    COALESCE(u."name", '') AS caretaker_name, b."notes"
FROM "bath_log" b
JOIN "baby" bb ON bb."id" = b."baby_id"
JOIN "users" u ON u."id" = b."caretaker_id"
WHERE b."family_id" = sqlc.arg(family_id)
ORDER BY b."time" ASC, b."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportNotes :many
SELECT
    n."baby_id", bb."name" AS baby_name, n."time", n."content",
    COALESCE(u."name", '') AS caretaker_name, n."notes"
FROM "note_log" n
JOIN "baby" bb ON bb."id" = n."baby_id"
JOIN "users" u ON u."id" = n."caretaker_id"
WHERE n."family_id" = sqlc.arg(family_id)
ORDER BY n."time" ASC, n."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportMilestones :many
SELECT
    m."baby_id", bb."name" AS baby_name, m."time", m."title",
    COALESCE(u."name", '') AS caretaker_name, m."notes"
FROM "milestone_log" m
JOIN "baby" bb ON bb."id" = m."baby_id"
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
ORDER BY m."time" ASC, m."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportMeasurements :many
SELECT
    m."baby_id", bb."name" AS baby_name, m."time", m."type", m."value",
    COALESCE(u."name", '') AS caretaker_name, m."notes"
FROM "measurement_log" m
JOIN "baby" bb ON bb."id" = m."baby_id"
JOIN "users" u ON u."id" = m."caretaker_id"
WHERE m."family_id" = sqlc.arg(family_id)
ORDER BY m."time" ASC, m."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportPumps :many
SELECT
    p."baby_id", bb."name" AS baby_name, p."time", p."amount_ml", p."side", p."duration_min",
    COALESCE(u."name", '') AS caretaker_name, p."notes"
FROM "pump_log" p
JOIN "baby" bb ON bb."id" = p."baby_id"
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
ORDER BY p."time" ASC, p."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportPlays :many
SELECT
    p."baby_id", bb."name" AS baby_name, p."start_time", p."end_time", p."type",
    COALESCE(u."name", '') AS caretaker_name, p."notes"
FROM "play_log" p
JOIN "baby" bb ON bb."id" = p."baby_id"
JOIN "users" u ON u."id" = p."caretaker_id"
WHERE p."family_id" = sqlc.arg(family_id)
ORDER BY p."start_time" ASC, p."id" ASC
LIMIT sqlc.arg(lim);

-- name: ExportVaccines :many
SELECT
    v."baby_id", bb."name" AS baby_name, v."time", v."name", v."dose_number",
    COALESCE(u."name", '') AS caretaker_name, v."notes"
FROM "vaccine_log" v
JOIN "baby" bb ON bb."id" = v."baby_id"
JOIN "users" u ON u."id" = v."caretaker_id"
WHERE v."family_id" = sqlc.arg(family_id)
ORDER BY v."time" ASC, v."id" ASC
LIMIT sqlc.arg(lim);
