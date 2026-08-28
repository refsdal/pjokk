CREATE TABLE "admin_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"read_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "baby" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"name" text NOT NULL,
	"birth_date" timestamp with time zone NOT NULL,
	"sex" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bath_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_assignee" (
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "calendar_assignee_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_event" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"category" text DEFAULT 'other' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"duration_min" integer,
	"remind_minutes_before" integer,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event_baby" (
	"event_id" text NOT NULL,
	"baby_id" text NOT NULL,
	CONSTRAINT "calendar_event_baby_event_id_baby_id_pk" PRIMARY KEY("event_id","baby_id")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"icon" text,
	"phone" text,
	"email" text,
	"website" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_baby" (
	"contact_id" text NOT NULL,
	"baby_id" text NOT NULL,
	CONSTRAINT "contact_baby_contact_id_baby_id_pk" PRIMARY KEY("contact_id","baby_id")
);
--> statement-breakpoint
CREATE TABLE "diaper_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_invite" (
	"code" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"amount_ml" integer,
	"side" text,
	"duration_min" integer,
	"left_min" integer,
	"right_min" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"value" double precision NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medicine_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"amount" double precision,
	"unit" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestone_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"type" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pump_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"side" text,
	"amount_ml" integer,
	"duration_min" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_pref" (
	"user_id" text NOT NULL,
	"family_id" text NOT NULL,
	"feed_reminder_hours" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	CONSTRAINT "push_pref_user_id_family_id_pk" PRIMARY KEY("user_id","family_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sleep_location" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sleep_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"location" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccine_dismissal" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"dismissed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccine_document" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"vaccine_log_id" text NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccine_log" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"baby_id" text NOT NULL,
	"caretaker_id" text NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"dose_number" integer,
	"schedule_slot" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"reference_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"cancel_at_period_end" boolean,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"seats" integer,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"billing_interval" text,
	"stripe_schedule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_id_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baby" ADD CONSTRAINT "baby_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bath_log" ADD CONSTRAINT "bath_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bath_log" ADD CONSTRAINT "bath_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bath_log" ADD CONSTRAINT "bath_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_assignee" ADD CONSTRAINT "calendar_assignee_event_id_calendar_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_assignee" ADD CONSTRAINT "calendar_assignee_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_baby" ADD CONSTRAINT "calendar_event_baby_event_id_calendar_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_baby" ADD CONSTRAINT "calendar_event_baby_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_baby" ADD CONSTRAINT "contact_baby_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_baby" ADD CONSTRAINT "contact_baby_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diaper_log" ADD CONSTRAINT "diaper_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diaper_log" ADD CONSTRAINT "diaper_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diaper_log" ADD CONSTRAINT "diaper_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_invite" ADD CONSTRAINT "family_invite_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_invite" ADD CONSTRAINT "family_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_log" ADD CONSTRAINT "feed_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_log" ADD CONSTRAINT "feed_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_log" ADD CONSTRAINT "feed_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_log" ADD CONSTRAINT "measurement_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_log" ADD CONSTRAINT "medicine_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_log" ADD CONSTRAINT "medicine_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine_log" ADD CONSTRAINT "medicine_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_log" ADD CONSTRAINT "milestone_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_log" ADD CONSTRAINT "milestone_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_log" ADD CONSTRAINT "milestone_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_log" ADD CONSTRAINT "note_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_log" ADD CONSTRAINT "note_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_log" ADD CONSTRAINT "note_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_log" ADD CONSTRAINT "play_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_log" ADD CONSTRAINT "play_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_log" ADD CONSTRAINT "play_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pump_log" ADD CONSTRAINT "pump_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pump_log" ADD CONSTRAINT "pump_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pump_log" ADD CONSTRAINT "pump_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_pref" ADD CONSTRAINT "push_pref_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_pref" ADD CONSTRAINT "push_pref_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_location" ADD CONSTRAINT "sleep_location_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_log" ADD CONSTRAINT "sleep_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_log" ADD CONSTRAINT "sleep_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_log" ADD CONSTRAINT "sleep_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_dismissal" ADD CONSTRAINT "vaccine_dismissal_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_dismissal" ADD CONSTRAINT "vaccine_dismissal_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_dismissal" ADD CONSTRAINT "vaccine_dismissal_dismissed_by_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_document" ADD CONSTRAINT "vaccine_document_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_document" ADD CONSTRAINT "vaccine_document_vaccine_log_id_vaccine_log_id_fk" FOREIGN KEY ("vaccine_log_id") REFERENCES "public"."vaccine_log"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_document" ADD CONSTRAINT "vaccine_document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_log" ADD CONSTRAINT "vaccine_log_family_id_organization_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_log" ADD CONSTRAINT "vaccine_log_baby_id_baby_id_fk" FOREIGN KEY ("baby_id") REFERENCES "public"."baby"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccine_log" ADD CONSTRAINT "vaccine_log_caretaker_id_user_id_fk" FOREIGN KEY ("caretaker_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_time_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_key_family_idx" ON "api_key" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "baby_family_idx" ON "baby" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "bath_family_time_idx" ON "bath_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "calendar_family_start_idx" ON "calendar_event" USING btree ("family_id","start_time");--> statement-breakpoint
CREATE INDEX "contact_family_idx" ON "contact" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "diaper_family_time_idx" ON "diaper_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "diaper_baby_idx" ON "diaper_log" USING btree ("baby_id");--> statement-breakpoint
CREATE INDEX "invite_family_idx" ON "family_invite" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "feed_family_time_idx" ON "feed_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "feed_baby_idx" ON "feed_log" USING btree ("baby_id");--> statement-breakpoint
CREATE INDEX "measurement_family_time_idx" ON "measurement_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "medicine_family_time_idx" ON "medicine_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "milestone_family_time_idx" ON "milestone_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "note_family_time_idx" ON "note_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "play_family_start_idx" ON "play_log" USING btree ("family_id","start_time");--> statement-breakpoint
CREATE INDEX "play_baby_idx" ON "play_log" USING btree ("baby_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_one_active_per_baby" ON "play_log" USING btree ("baby_id") WHERE end_time IS NULL;--> statement-breakpoint
CREATE INDEX "pump_family_time_idx" ON "pump_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "push_sub_user_idx" ON "push_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rate_limit_expires_idx" ON "rate_limit" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sleep_location_family_idx" ON "sleep_location" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sleep_family_start_idx" ON "sleep_log" USING btree ("family_id","start_time");--> statement-breakpoint
CREATE INDEX "sleep_baby_idx" ON "sleep_log" USING btree ("baby_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sleep_one_active_per_baby" ON "sleep_log" USING btree ("baby_id") WHERE end_time IS NULL;--> statement-breakpoint
CREATE INDEX "vaccine_dismissal_family_idx" ON "vaccine_dismissal" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vaccine_dismissal_baby_slot" ON "vaccine_dismissal" USING btree ("baby_id","slot_key");--> statement-breakpoint
CREATE INDEX "vaccine_doc_log_idx" ON "vaccine_document" USING btree ("vaccine_log_id");--> statement-breakpoint
CREATE INDEX "vaccine_doc_family_idx" ON "vaccine_document" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "vaccine_family_time_idx" ON "vaccine_log" USING btree ("family_id","time");--> statement-breakpoint
CREATE INDEX "vaccine_baby_idx" ON "vaccine_log" USING btree ("baby_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_reference_idx" ON "subscription" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");