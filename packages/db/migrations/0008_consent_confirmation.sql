ALTER TABLE `mimics` ADD `confirmed_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `mimics` ADD `declined_json` text DEFAULT '[]' NOT NULL;