-- +goose Up

-- ===========================================================================
-- Photos on milestones (issue #48). The first attachment path that a family
-- will actually use: "first smile", "first tooth". Milestones only — a
-- photo on every diaper is another product's problem.
--
--   object_key     server-generated key in the storage port
--                  ("milestone-photos/<family>/<uuid>.jpg"); a client
--                  filename never reaches the store, and every photo is
--                  re-encoded to JPEG on the server (internal/api/photos.go),
--                  which proves the bytes are an image and strips EXIF so
--                  no GPS fix is ever stored
--   width/height   of the stored JPEG, for the timeline thumbnail's box
--   size           stored bytes; summed per family against PHOTO_QUOTA_MB
--
-- No uploaded_by: the milestone carries the attribution, and a users FK
-- here would only add a branch to ReassignUserReferences for nothing.
-- Deleting the milestone cascades the rows; the objects are deleted by the
-- handler afterwards, keys read first (the vaccine-document pattern).
-- ===========================================================================
CREATE TABLE "milestone_photo" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"milestone_log_id" text NOT NULL REFERENCES "milestone_log" ("id") ON DELETE CASCADE,
	"object_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "milestone_photo_log_idx" ON "milestone_photo" ("milestone_log_id");
CREATE INDEX "milestone_photo_family_idx" ON "milestone_photo" ("family_id");

-- +goose Down
DROP TABLE "milestone_photo";
