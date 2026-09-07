-- +goose Up

-- ===========================================================================
-- Reminders beyond the feed gap (issue #45).
--
-- push_pref held exactly one reminder per (user, family): "no feed for N
-- hours", family-wide. This table is a small per-user LIST instead, keeping
-- the delivery path (the */15 cron, one nudge per gap) exactly as it was:
--
--   kind          feed | diaper | pump | medicine | custom
--   mode          since_last — fire once the newest log of `kind` is older
--                 than interval_min (the old feed-gap rule, per kind);
--                 at_time   — fire once per matching day at at_minute local
--                 (a `custom` reminder is always at_time: there is nothing
--                 to be "since")
--   baby_id       NULL = any baby in the family; set = that baby only
--   days_mask     bit 0 = Monday … bit 6 = Sunday; 127 = every day
--   tz            IANA zone the local wall clock is read in (at_minute,
--                 quiet hours, days). Stored per reminder because users have
--                 no timezone column and a phone can move; the binary embeds
--                 tzdata, so any name time.LoadLocation accepts works in the
--                 scratch image
--   quiet_start/  local hours (0–23) during which nothing fires, or both
--   quiet_end     NULL. A since_last reminder that comes due inside the
--                 window is NOT latched, so it fires at the first tick after
--                 the window ends if it is still overdue
--   label         the medicine name a medicine reminder keys on (NULL = any
--                 medicine), or a custom reminder's text
--   last_fired_at the idempotency latch, exactly as push_pref's
--                 last_reminded_at: since_last re-fires only after a newer
--                 log, at_time only for a newer day slot
--
-- Personal, not family state: user_id cascades (a reminder dies with its
-- account, nothing to reassign), so it needs no branch in
-- ReassignUserReferences.
-- ===========================================================================
CREATE TABLE "reminder" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"baby_id" text REFERENCES "baby" ("id") ON DELETE CASCADE,
	"kind" text NOT NULL CHECK ("kind" IN ('feed', 'diaper', 'pump', 'medicine', 'custom')),
	"mode" text NOT NULL CHECK ("mode" IN ('since_last', 'at_time')),
	"interval_min" integer CHECK ("interval_min" BETWEEN 15 AND 1440),
	"at_minute" integer CHECK ("at_minute" BETWEEN 0 AND 1439),
	"days_mask" integer NOT NULL DEFAULT 127 CHECK ("days_mask" BETWEEN 1 AND 127),
	"tz" text NOT NULL,
	"quiet_start" integer CHECK ("quiet_start" BETWEEN 0 AND 23),
	"quiet_end" integer CHECK ("quiet_end" BETWEEN 0 AND 23),
	"label" text,
	"last_fired_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "reminder_mode_fields" CHECK (
		("mode" = 'since_last' AND "interval_min" IS NOT NULL)
		OR ("mode" = 'at_time' AND "at_minute" IS NOT NULL)
	),
	CONSTRAINT "reminder_custom_is_at_time" CHECK ("kind" != 'custom' OR "mode" = 'at_time'),
	CONSTRAINT "reminder_quiet_pair" CHECK (("quiet_start" IS NULL) = ("quiet_end" IS NULL))
);
CREATE INDEX "reminder_user_family_idx" ON "reminder" ("user_id", "family_id");

-- The one reminder push_pref could express becomes one row. The timezone
-- only matters for quiet hours and fixed times, which these rows have
-- none of; Europe/Oslo is the app's home and a harmless default here.
INSERT INTO "reminder" ("family_id", "user_id", "kind", "mode", "interval_min", "tz", "last_fired_at")
SELECT "family_id", "user_id", 'feed', 'since_last', "feed_reminder_hours" * 60, 'Europe/Oslo', "last_reminded_at"
FROM "push_pref"
WHERE "feed_reminder_hours" > 0;

DROP TABLE "push_pref";

-- +goose Down
CREATE TABLE "push_pref" (
	"user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
	"family_id" text NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
	"feed_reminder_hours" integer NOT NULL DEFAULT 0,
	"last_reminded_at" timestamptz,
	CONSTRAINT "push_pref_pk" PRIMARY KEY ("user_id", "family_id")
);
-- Only whole-hour, family-wide feed gaps fit the old shape; one row per
-- (user, family), the shortest interval winning.
INSERT INTO "push_pref" ("user_id", "family_id", "feed_reminder_hours", "last_reminded_at")
SELECT "user_id", "family_id", MIN("interval_min") / 60, MAX("last_fired_at")
FROM "reminder"
WHERE "kind" = 'feed' AND "mode" = 'since_last' AND "baby_id" IS NULL AND "interval_min" >= 60
GROUP BY "user_id", "family_id";
DROP TABLE "reminder";
