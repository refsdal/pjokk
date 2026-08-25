-- Feedback batch: per-side nursing minutes + custom sleep locations.
ALTER TABLE `feed_log` ADD `left_min` integer;--> statement-breakpoint
ALTER TABLE `feed_log` ADD `right_min` integer;--> statement-breakpoint
CREATE TABLE `sleep_location` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sleep_location_family_idx` ON `sleep_location` (`family_id`);
