-- +goose Up

-- The app's language as a PERSON's preference (DECISIONS 2026-09-11), like
-- units in 00013. Two columns because "auto" (follow the device) is a
-- choice the server cannot resolve:
--
--   language_mode  what the person picked in Settings: auto, en or nb.
--                  NULL = never sent by an app yet; the first signed-in
--                  device uploads its own (previously device-local) choice
--                  rather than having the server's default overwrite it.
--   language       the language in effect, as the app last resolved it —
--                  what server-written text (push notifications) uses.
ALTER TABLE "users"
	ADD COLUMN "language_mode" text
		CHECK ("language_mode" IN ('auto', 'en', 'nb')),
	ADD COLUMN "language" text NOT NULL DEFAULT 'en'
		CHECK ("language" IN ('en', 'nb'));

-- +goose Down
ALTER TABLE "users" DROP COLUMN "language", DROP COLUMN "language_mode";
