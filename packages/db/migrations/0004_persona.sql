CREATE TABLE `persona_curations` (
	`mimic_id` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `persona_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`config_hash` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`model_snapshot` text NOT NULL,
	`draft_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `persona_drafts_mimic_idx` ON `persona_drafts` (`mimic_id`,`created_at`);