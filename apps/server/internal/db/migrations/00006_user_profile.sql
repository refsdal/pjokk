-- +goose Up

-- ===========================================================================
-- User profile (spec: docs/superpowers/specs/2026-09-06-user-profile-and-
-- avatar-design.md). Global, per user, the same in every family.
--
--   nickname            shown instead of the full name wherever the family
--                       sees a person; NULL/blank = use the full name
--   phone               private to the user for now (not on Member)
--   avatar_key          storage.Storage key of the JPEG; NULL = no photo
--   avatar_imported_at  set the first time a Google picture import is
--                       ATTEMPTED, success or not, so a photo the user
--                       removed is never silently re-imported
--   display_name        THE one place the "nickname, else full name" rule
--                       lives: every attribution join reads this column, so
--                       neither the handlers nor the SPA know the rule
--
-- `image` (00001_init.sql) keeps its meaning — the picture URL Google's
-- profile mapping writes at sign-in — and is now only an import source.
-- ===========================================================================
ALTER TABLE "users"
    ADD COLUMN "nickname" text,
    ADD COLUMN "phone" text,
    ADD COLUMN "avatar_key" text,
    ADD COLUMN "avatar_imported_at" timestamptz,
    ADD COLUMN "display_name" text GENERATED ALWAYS AS
        (COALESCE(NULLIF(btrim("nickname"), ''), "name", '')) STORED;

-- +goose Down
ALTER TABLE "users"
    DROP COLUMN "display_name",
    DROP COLUMN "avatar_imported_at",
    DROP COLUMN "avatar_key",
    DROP COLUMN "phone",
    DROP COLUMN "nickname";
