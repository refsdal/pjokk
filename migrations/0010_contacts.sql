-- Contacts (premium): the family's people. Not a log — no time column and
-- no caretaker attribution. Babies attach via contact_baby; zero link rows
-- means the contact belongs to the whole family.
CREATE TABLE `contact` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`icon` text,
	`phone` text,
	`email` text,
	`website` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_family_idx` ON `contact` (`family_id`);--> statement-breakpoint
CREATE TABLE `contact_baby` (
	`contact_id` text NOT NULL,
	`baby_id` text NOT NULL,
	PRIMARY KEY(`contact_id`, `baby_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baby_id`) REFERENCES `baby`(`id`) ON UPDATE no action ON DELETE cascade
);
