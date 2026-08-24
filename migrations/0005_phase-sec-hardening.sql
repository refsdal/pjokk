ALTER TABLE `api_key` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `api_key` ADD `read_only` integer DEFAULT false NOT NULL;