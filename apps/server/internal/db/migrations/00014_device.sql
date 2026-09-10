-- +goose Up

-- Kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md):
-- a tablet enrolled as the FAMILY's care station, with a credential of its
-- own instead of a person's session. Three states, read off the columns:
--
--   pending  enrol_code_hash set, token_hash NULL — waiting for the tablet
--   active   token_hash set, revoked_at NULL
--   revoked  revoked_at set (by an admin, or by the PIN on the tablet)
--
-- Only hashes are stored: the one-time code and the token as SHA-256 (both
-- carry enough entropy for a fast hash, like api_key), the PIN as an HMAC
-- keyed from AUTH_SECRET (a 4-6 digit PIN would not survive a bare hash).
CREATE TABLE "device" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60),
	"created_by" text NOT NULL REFERENCES "users" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"enrol_code_hash" text,
	"enrol_expires_at" timestamptz,
	"token_hash" text,
	"pin_hash" text,
	"enrolled_at" timestamptz,
	"last_used_at" timestamptz,
	"revoked_at" timestamptz,
	CONSTRAINT "device_token_hash_unique" UNIQUE ("token_hash"),
	-- No device is ever enrolled without a PIN: both arrive in one UPDATE.
	CONSTRAINT "device_token_needs_pin" CHECK (("token_hash" IS NULL) = ("pin_hash" IS NULL))
);
CREATE INDEX "device_family_idx" ON "device" ("family_id");
CREATE UNIQUE INDEX "device_enrol_code_idx" ON "device" ("enrol_code_hash")
	WHERE "enrol_code_hash" IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS "device";
