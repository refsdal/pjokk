-- +goose Up

-- What the logs cannot know about a child (issue #109): the few lines a
-- barnehage asks every family for before tilvenning, kept beside the baby
-- so the "About <name>" sheet prints them with what the logs DO know.
-- Its own table rather than columns on "baby": every reader of a baby row
-- (and its full-row UPDATE … RETURNING *) stays as it is, and the text is
-- fetched only where it is edited and printed.
CREATE TABLE "baby_about" (
	"baby_id" text PRIMARY KEY REFERENCES "baby" ("id") ON DELETE CASCADE,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"comfort" text,
	"falls_asleep" text,
	"diet" text,
	"other" text,
	"updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "baby_about_family_idx" ON "baby_about" ("family_id");

-- +goose Down
DROP TABLE IF EXISTS "baby_about";
