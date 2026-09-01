-- +goose Up

-- ===========================================================================
-- Auth tables (Limen-shaped)
--
-- Limen does not ship a published schema; these are a best-effort port from
-- REF §B4's column lists, using this file's own `id text PRIMARY KEY DEFAULT
-- gen_random_uuid()::text` convention for any table whose PK isn't called out
-- explicitly in the column list. Task 4 runtime-verifies this against actual
-- Limen migrations (`limen generate migrations`) and adds a follow-up
-- migration if the real column set differs — this file stays authoritative
-- until then.
-- ===========================================================================

CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"public_id" text NOT NULL DEFAULT gen_random_uuid()::text,
	"first_name" text,
	"last_name" text,
	"email" text NOT NULL,
	"password" text,
	"email_verified_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"deleted_at" timestamptz,
	-- Our additional fields (REF §A2), not part of Limen's own column set.
	"name" text,
	"image" text,
	"role" text,
	"banned" boolean NOT NULL DEFAULT false,
	"ban_reason" text,
	CONSTRAINT "users_email_unique" UNIQUE ("email"),
	CONSTRAINT "users_public_id_unique" UNIQUE ("public_id")
);

CREATE TABLE "organizations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"name" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	-- Our additional field (REF §A2).
	"plan" text NOT NULL DEFAULT 'free',
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "organizations_slug_unique" UNIQUE ("slug")
);

CREATE TABLE "sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"token" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL,
	"last_access" timestamptz,
	"metadata" text,
	-- Org plugin's field (REF §A2).
	"active_organization_id" text REFERENCES "organizations" ("id") ON DELETE SET NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE ("token")
);

CREATE TABLE "accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamptz,
	"refresh_token_expires_at" timestamptz,
	"scope" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "accounts_provider_account_unique" UNIQUE ("provider", "provider_account_id")
);

CREATE TABLE "verifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Limen's own rate limiter table — distinct from our `rate_limit` below,
-- which is the app's own IP-hash rate limiter and predates Limen entirely.
CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"key" text NOT NULL,
	"count" integer NOT NULL DEFAULT 0,
	"expires_at" timestamptz NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE ("key")
);

CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "organization_roles" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "organization_member_roles" (
	"organization_member_id" text NOT NULL REFERENCES "organization_members" ("id") ON DELETE CASCADE,
	"organization_role_id" text NOT NULL REFERENCES "organization_roles" ("id") ON DELETE CASCADE,
	CONSTRAINT "organization_member_roles_pk" PRIMARY KEY ("organization_member_id", "organization_role_id")
);

-- Limen's own invitation table (email-addressed). Unused by us — our real
-- invite mechanism is the domain `family_invite` table below — but Limen
-- ships it, so it must exist for the org plugin to function.
CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"organization_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"role" text,
	"status" text NOT NULL DEFAULT 'pending',
	"expires_at" timestamptz NOT NULL,
	"inviter_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
CREATE INDEX "accounts_user_idx" ON "accounts" ("user_id");
CREATE INDEX "verifications_identifier_idx" ON "verifications" ("identifier");
CREATE INDEX "organization_members_org_idx" ON "organization_members" ("organization_id");
CREATE INDEX "organization_members_user_idx" ON "organization_members" ("user_id");
CREATE INDEX "organization_roles_org_idx" ON "organization_roles" ("organization_id");
CREATE INDEX "organization_invitations_org_idx" ON "organization_invitations" ("organization_id");
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations" ("email");

-- Tombstone user: the target for FKs left behind by a deleted account.
-- Inserted here so it exists from the first boot; app startup re-runs this
-- with ON CONFLICT DO NOTHING as a belt-and-braces guard.
INSERT INTO "users" ("id", "email", "name", "banned")
VALUES ('user_tombstone', 'deleted@pjokk.invalid', 'Deleted user', true)
ON CONFLICT DO NOTHING;

-- ===========================================================================
-- Domain tables (ported near-verbatim from apps/api/migrations/0000_init.sql;
-- FKs repointed from organization(id)/"user"(id) to organizations(id)/users(id))
-- ===========================================================================

CREATE TABLE "sleep_location" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "sleep_location_family_idx" ON "sleep_location" ("family_id");

CREATE TABLE "baby" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"birth_date" timestamptz NOT NULL,
	"sex" text CHECK ("sex" IN ('girl', 'boy')),
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "baby_family_idx" ON "baby" ("family_id");

CREATE TABLE "api_key" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text NOT NULL REFERENCES "users" ("id"),
	"last_used_at" timestamptz,
	"revoked_at" timestamptz,
	"expires_at" timestamptz,
	"read_only" boolean NOT NULL DEFAULT false,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "api_key_key_hash_unique" UNIQUE ("key_hash")
);
CREATE INDEX "api_key_family_idx" ON "api_key" ("family_id");

CREATE TABLE "sleep_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"start_time" timestamptz NOT NULL,
	"end_time" timestamptz,
	"location" text,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "sleep_family_start_idx" ON "sleep_log" ("family_id", "start_time");
CREATE INDEX "sleep_baby_idx" ON "sleep_log" ("baby_id");
CREATE UNIQUE INDEX "sleep_one_active_per_baby" ON "sleep_log" ("baby_id") WHERE "end_time" IS NULL;

CREATE TABLE "feed_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"type" text NOT NULL CHECK ("type" IN ('bottle', 'breast', 'solids')),
	"amount_ml" integer,
	"side" text CHECK ("side" IN ('left', 'right', 'both')),
	"duration_min" integer,
	"left_min" integer,
	"right_min" integer,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "feed_family_time_idx" ON "feed_log" ("family_id", "time");
CREATE INDEX "feed_baby_idx" ON "feed_log" ("baby_id");

CREATE TABLE "diaper_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"type" text NOT NULL CHECK ("type" IN ('wet', 'dirty', 'both')),
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "diaper_family_time_idx" ON "diaper_log" ("family_id", "time");
CREATE INDEX "diaper_baby_idx" ON "diaper_log" ("baby_id");

CREATE TABLE "medicine_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"name" text NOT NULL,
	"amount" double precision,
	"unit" text CHECK ("unit" IN ('ml', 'mg', 'drops', 'dose')),
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "medicine_family_time_idx" ON "medicine_log" ("family_id", "time");

CREATE TABLE "bath_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "bath_family_time_idx" ON "bath_log" ("family_id", "time");

CREATE TABLE "note_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"content" text NOT NULL,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "note_family_time_idx" ON "note_log" ("family_id", "time");

CREATE TABLE "milestone_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "milestone_family_time_idx" ON "milestone_log" ("family_id", "time");

CREATE TABLE "measurement_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"type" text NOT NULL CHECK ("type" IN ('weight', 'length', 'head')),
	"value" double precision NOT NULL,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "measurement_family_time_idx" ON "measurement_log" ("family_id", "time");

CREATE TABLE "pump_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"side" text CHECK ("side" IN ('left', 'right', 'both')),
	"amount_ml" integer,
	"duration_min" integer,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "pump_family_time_idx" ON "pump_log" ("family_id", "time");

CREATE TABLE "play_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"type" text NOT NULL CHECK ("type" IN ('tummy', 'walk', 'play')),
	"start_time" timestamptz NOT NULL,
	"end_time" timestamptz,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "play_family_start_idx" ON "play_log" ("family_id", "start_time");
CREATE INDEX "play_baby_idx" ON "play_log" ("baby_id");
CREATE UNIQUE INDEX "play_one_active_per_baby" ON "play_log" ("baby_id") WHERE "end_time" IS NULL;

CREATE TABLE "vaccine_log" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"caretaker_id" text NOT NULL REFERENCES "users" ("id"),
	"time" timestamptz NOT NULL,
	"name" text NOT NULL,
	"dose_number" integer,
	"schedule_slot" text,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "vaccine_family_time_idx" ON "vaccine_log" ("family_id", "time");
CREATE INDEX "vaccine_baby_idx" ON "vaccine_log" ("baby_id");

CREATE TABLE "vaccine_document" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"vaccine_log_id" text NOT NULL REFERENCES "vaccine_log" ("id") ON DELETE CASCADE,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" text NOT NULL REFERENCES "users" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "vaccine_doc_log_idx" ON "vaccine_document" ("vaccine_log_id");
CREATE INDEX "vaccine_doc_family_idx" ON "vaccine_document" ("family_id");

CREATE TABLE "vaccine_dismissal" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	"slot_key" text NOT NULL,
	"dismissed_by" text NOT NULL REFERENCES "users" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "vaccine_dismissal_family_idx" ON "vaccine_dismissal" ("family_id");
CREATE UNIQUE INDEX "vaccine_dismissal_baby_slot" ON "vaccine_dismissal" ("baby_id", "slot_key");

CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE ("endpoint")
);
CREATE INDEX "push_sub_user_idx" ON "push_subscription" ("user_id");

CREATE TABLE "push_pref" (
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"feed_reminder_hours" integer NOT NULL DEFAULT 0,
	"last_reminded_at" timestamptz,
	CONSTRAINT "push_pref_pk" PRIMARY KEY ("user_id", "family_id")
);

CREATE TABLE "admin_audit" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"admin_id" text NOT NULL REFERENCES "users" ("id"),
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "admin_audit_time_idx" ON "admin_audit" ("created_at");

CREATE TABLE "family_invite" (
	"code" text PRIMARY KEY,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"role" text NOT NULL CHECK ("role" IN ('admin', 'member')),
	"expires_at" timestamptz NOT NULL,
	"max_uses" integer NOT NULL,
	"used_count" integer NOT NULL DEFAULT 0,
	"revoked_at" timestamptz,
	"created_by" text NOT NULL REFERENCES "users" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "invite_family_idx" ON "family_invite" ("family_id");

CREATE TABLE "contact" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"role" text,
	"icon" text CHECK ("icon" IN (
		'user', 'doctor', 'nurse', 'hospital', 'dental', 'family',
		'grandparent', 'daycare', 'friend', 'phone'
	)),
	"phone" text,
	"email" text,
	"website" text,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "contact_family_idx" ON "contact" ("family_id");

CREATE TABLE "contact_baby" (
	"contact_id" text NOT NULL REFERENCES "contact" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	CONSTRAINT "contact_baby_pk" PRIMARY KEY ("contact_id", "baby_id")
);

CREATE TABLE "calendar_event" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"created_by" text NOT NULL REFERENCES "users" ("id"),
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"category" text NOT NULL DEFAULT 'other' CHECK ("category" IN (
		'doctor', 'vaccination', 'babysitting', 'family', 'other'
	)),
	"start_time" timestamptz NOT NULL,
	"all_day" boolean NOT NULL DEFAULT false,
	"duration_min" integer,
	"remind_minutes_before" integer,
	"reminded_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "calendar_family_start_idx" ON "calendar_event" ("family_id", "start_time");

CREATE TABLE "calendar_event_baby" (
	"event_id" text NOT NULL REFERENCES "calendar_event" ("id") ON DELETE CASCADE,
	"baby_id" text NOT NULL REFERENCES "baby" ("id") ON DELETE CASCADE,
	CONSTRAINT "calendar_event_baby_pk" PRIMARY KEY ("event_id", "baby_id")
);

CREATE TABLE "calendar_assignee" (
	"event_id" text NOT NULL REFERENCES "calendar_event" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id"),
	CONSTRAINT "calendar_assignee_pk" PRIMARY KEY ("event_id", "user_id")
);

-- Ours, distinct from Limen's `rate_limits` above.
CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY,
	"count" integer NOT NULL DEFAULT 0,
	"expires_at" timestamptz NOT NULL
);
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit" ("expires_at");

-- +goose Down

DROP TABLE IF EXISTS "rate_limit";
DROP TABLE IF EXISTS "calendar_assignee";
DROP TABLE IF EXISTS "calendar_event_baby";
DROP TABLE IF EXISTS "calendar_event";
DROP TABLE IF EXISTS "contact_baby";
DROP TABLE IF EXISTS "contact";
DROP TABLE IF EXISTS "family_invite";
DROP TABLE IF EXISTS "admin_audit";
DROP TABLE IF EXISTS "push_pref";
DROP TABLE IF EXISTS "push_subscription";
DROP TABLE IF EXISTS "vaccine_dismissal";
DROP TABLE IF EXISTS "vaccine_document";
DROP TABLE IF EXISTS "vaccine_log";
DROP TABLE IF EXISTS "play_log";
DROP TABLE IF EXISTS "pump_log";
DROP TABLE IF EXISTS "measurement_log";
DROP TABLE IF EXISTS "milestone_log";
DROP TABLE IF EXISTS "note_log";
DROP TABLE IF EXISTS "bath_log";
DROP TABLE IF EXISTS "medicine_log";
DROP TABLE IF EXISTS "diaper_log";
DROP TABLE IF EXISTS "feed_log";
DROP TABLE IF EXISTS "sleep_log";
DROP TABLE IF EXISTS "api_key";
DROP TABLE IF EXISTS "baby";
DROP TABLE IF EXISTS "sleep_location";

DROP TABLE IF EXISTS "organization_invitations";
DROP TABLE IF EXISTS "organization_member_roles";
DROP TABLE IF EXISTS "organization_roles";
DROP TABLE IF EXISTS "organization_members";
DROP TABLE IF EXISTS "rate_limits";
DROP TABLE IF EXISTS "verifications";
DROP TABLE IF EXISTS "accounts";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "organizations";
DROP TABLE IF EXISTS "users";
