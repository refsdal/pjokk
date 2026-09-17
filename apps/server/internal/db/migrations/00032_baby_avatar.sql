-- +goose Up

-- A photo of the baby, for the baby row in the header and the settings
-- pages: users.avatar_key (00006_user_profile.sql) transposed onto the
-- baby. storage.Storage key of the JPEG under "baby-avatars/<family>/";
-- NULL = no photo, and the initial stands in. Set only through
-- internal/api/baby_avatar.go, which re-encodes whatever arrives (no EXIF
-- reaches the store) and deletes the previous object. Unlike a person's
-- photo, the nightly photo backup (jobs/photo_backup.go) copies these, and
-- a family restore brings them back.
ALTER TABLE "baby" ADD COLUMN "avatar_key" text;

-- +goose Down
ALTER TABLE "baby" DROP COLUMN "avatar_key";
