-- What the logs cannot know about a child (issue #109, 00025).

-- name: GetBabyAbout :one
SELECT "comfort", "falls_asleep", "diet", "other"
FROM "baby_about"
WHERE "family_id" = $1 AND "baby_id" = $2;

-- name: PutBabyAbout :exec
-- The family scope is in the conflict arm too: a baby id from another
-- family can only ever insert (and the handler has already refused it).
INSERT INTO "baby_about" ("baby_id", "family_id", "comfort", "falls_asleep", "diet", "other")
VALUES (sqlc.arg(baby_id), sqlc.arg(family_id), sqlc.narg(comfort), sqlc.narg(falls_asleep), sqlc.narg(diet), sqlc.narg(other))
ON CONFLICT ("baby_id") DO UPDATE
SET "comfort" = EXCLUDED."comfort", "falls_asleep" = EXCLUDED."falls_asleep",
    "diet" = EXCLUDED."diet", "other" = EXCLUDED."other", "updated_at" = now()
WHERE "baby_about"."family_id" = EXCLUDED."family_id";
