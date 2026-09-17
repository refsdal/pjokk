-- Days at home with an ill child (issue #108). Family-scoped like every
-- domain table; a row is additionally one PERSON's, which is why the user
-- reference cascades (00024) and why a removed member's rows go with them
-- (auth.sql's DeleteMemberCareDays).

-- name: ListCareDays :many
SELECT
    c."id", c."user_id", COALESCE(u."display_name", '') AS user_name,
    c."baby_id", c."illness_id", c."date", c."fraction", c."note"
FROM "care_day" c
JOIN "users" u ON u."id" = c."user_id"
WHERE c."family_id" = sqlc.arg(family_id)
  AND c."date" >= sqlc.arg(from_date)::date
  AND c."date" <= sqlc.arg(to_date)::date
ORDER BY c."date" DESC, c."id" DESC;

-- name: GetCareDay :one
SELECT
    c."id", c."user_id", COALESCE(u."display_name", '') AS user_name,
    c."baby_id", c."illness_id", c."date", c."fraction", c."note"
FROM "care_day" c
JOIN "users" u ON u."id" = c."user_id"
WHERE c."family_id" = $1 AND c."id" = $2;

-- name: CreateCareDay :one
INSERT INTO "care_day" ("family_id", "user_id", "baby_id", "illness_id", "date", "fraction", "note")
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING "id";

-- name: UpdateCareDay :execrows
UPDATE "care_day"
SET
    "date" = CASE WHEN sqlc.arg(date_set)::bool THEN sqlc.narg(date_val)::date ELSE "date" END,
    "fraction" = CASE WHEN sqlc.arg(fraction_set)::bool THEN sqlc.narg(fraction_val)::double precision ELSE "fraction" END,
    "note" = CASE WHEN sqlc.arg(note_set)::bool THEN sqlc.narg(note_val)::text ELSE "note" END
WHERE "family_id" = sqlc.arg(family_id) AND "id" = sqlc.arg(id);

-- name: DeleteCareDay :execrows
DELETE FROM "care_day"
WHERE "family_id" = $1 AND "id" = $2;

-- name: CareDayTotals :many
-- Every CURRENT member with what they have used in the window and the
-- number they set for themselves, NULL when they have set none. Members
-- with nothing used are listed too: "0 of 10" is an answer.
SELECT
    m."user_id",
    COALESCE(u."display_name", '') AS user_name,
    COALESCE((
        SELECT SUM(c."fraction") FROM "care_day" c
        WHERE c."family_id" = m."organization_id" AND c."user_id" = m."user_id"
          AND c."date" >= sqlc.arg(from_date)::date AND c."date" <= sqlc.arg(to_date)::date
    ), 0)::double precision AS used,
    q."days" AS quota
FROM "organization_members" m
JOIN "users" u ON u."id" = m."user_id"
LEFT JOIN "care_day_quota" q ON q."family_id" = m."organization_id" AND q."user_id" = m."user_id"
WHERE m."organization_id" = sqlc.arg(family_id)
ORDER BY user_name, m."user_id";

-- name: SetCareDayQuota :exec
INSERT INTO "care_day_quota" ("family_id", "user_id", "days")
VALUES ($1, $2, $3)
ON CONFLICT ("family_id", "user_id") DO UPDATE SET "days" = EXCLUDED."days";

-- name: ClearCareDayQuota :exec
DELETE FROM "care_day_quota"
WHERE "family_id" = $1 AND "user_id" = $2;

-- name: CareDayIllnessInFamily :one
-- A care day may name an illness; it must be this family's.
SELECT "baby_id" FROM "illness" WHERE "family_id" = $1 AND "id" = $2;
