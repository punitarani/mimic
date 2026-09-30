ALTER TABLE `mimics` ADD `categories_json` text DEFAULT '["psychology","values","life","work"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mimics` ADD `consents_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `mimics` ADD `research_consents_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `mimics` ADD `scope_at` integer;