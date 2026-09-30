CREATE TABLE `item_stats` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`n_people` integer NOT NULL,
	`n_answers` integer NOT NULL,
	`answer_entropy` real,
	`baseline_error` real NOT NULL,
	`primary_error` real NOT NULL,
	`surprise` real NOT NULL,
	`lift` real,
	`mean_latency_ms` real NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `predictions` ADD `hypothesis` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `selection_json` text;