-- Calendar (premium): family-wide events + baby/assignee join tables.
CREATE TABLE `calendar_event` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`created_by` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`category` text DEFAULT 'other' NOT NULL,
	`start_time` integer NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`duration_min` integer,
	`remind_minutes_before` integer,
	`reminded_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `calendar_family_start_idx` ON `calendar_event` (`family_id`,`start_time`);--> statement-breakpoint
CREATE TABLE `calendar_event_baby` (
	`event_id` text NOT NULL,
	`baby_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `baby_id`),
	FOREIGN KEY (`event_id`) REFERENCES `calendar_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baby_id`) REFERENCES `baby`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_assignee` (
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `calendar_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
