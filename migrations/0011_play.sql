-- Play (premium): timed activities — tummy time, a walk, playing.
-- Structurally a sleep_log: end_time NULL means the session is running, and
-- the partial unique index is what makes the timer server-side.
CREATE TABLE `play_log` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`baby_id` text NOT NULL,
	`caretaker_id` text NOT NULL,
	`type` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baby_id`) REFERENCES `baby`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caretaker_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `play_family_start_idx` ON `play_log` (`family_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `play_baby_idx` ON `play_log` (`baby_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `play_one_active_per_baby` ON `play_log` (`baby_id`) WHERE end_time IS NULL;
