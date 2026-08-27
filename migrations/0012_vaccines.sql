-- Vaccines (free log) + documents (premium upload, stored in R2).
CREATE TABLE `vaccine_log` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`baby_id` text NOT NULL,
	`caretaker_id` text NOT NULL,
	`time` integer NOT NULL,
	`name` text NOT NULL,
	`dose_number` integer,
	`schedule_slot` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baby_id`) REFERENCES `baby`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caretaker_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vaccine_family_time_idx` ON `vaccine_log` (`family_id`,`time`);--> statement-breakpoint
CREATE INDEX `vaccine_baby_idx` ON `vaccine_log` (`baby_id`);--> statement-breakpoint
CREATE TABLE `vaccine_document` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`vaccine_log_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vaccine_log_id`) REFERENCES `vaccine_log`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vaccine_doc_log_idx` ON `vaccine_document` (`vaccine_log_id`);--> statement-breakpoint
CREATE INDEX `vaccine_doc_family_idx` ON `vaccine_document` (`family_id`);
