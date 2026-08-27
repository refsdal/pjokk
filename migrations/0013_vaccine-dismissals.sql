-- Programme slots a family has waved away for one baby. Stores the slot key
-- rather than a foreign key: the bundled programme is data that can change
-- without a migration.
CREATE TABLE `vaccine_dismissal` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`baby_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`dismissed_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baby_id`) REFERENCES `baby`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dismissed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vaccine_dismissal_family_idx` ON `vaccine_dismissal` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vaccine_dismissal_baby_slot` ON `vaccine_dismissal` (`baby_id`,`slot_key`);
