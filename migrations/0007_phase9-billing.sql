-- Phase 9: Stripe billing. Plugin-managed subscription state + per-entity
-- Stripe customer ids. organization.plan (added in 0000) becomes live.
ALTER TABLE `user` ADD COLUMN `stripe_customer_id` text;
--> statement-breakpoint
ALTER TABLE `organization` ADD COLUMN `stripe_customer_id` text;
--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`reference_id` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`status` text NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`cancel_at_period_end` integer,
	`cancel_at` integer,
	`canceled_at` integer,
	`ended_at` integer,
	`seats` integer,
	`trial_start` integer,
	`trial_end` integer,
	`billing_interval` text,
	`stripe_schedule_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscription_reference_idx` ON `subscription` (`reference_id`);
