CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`mimic_id` text NOT NULL,
	`seq` integer NOT NULL,
	`value` text NOT NULL,
	`why` text,
	`latency_ms` integer NOT NULL,
	`revealed_prediction` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answers_mimic_idx` ON `answers` (`mimic_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_mimic_seq_idx` ON `answers` (`mimic_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_idempotency_idx` ON `answers` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `answers_question_idx` ON `answers` (`question_id`);--> statement-breakpoint
CREATE TABLE `configs` (
	`hash` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`spec_json` text NOT NULL,
	`dataset_hash` text NOT NULL,
	`status` text NOT NULL,
	`metrics_json` text,
	`r2_report_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`arms_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`predicate` text NOT NULL,
	`object` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`source_url` text,
	`confidence` real NOT NULL,
	`user_state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `facts_mimic_idx` ON `facts` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `fidelity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mimic_id` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`acc` real NOT NULL,
	`acc_baseline` real,
	`self_consistency` real NOT NULL,
	`fidelity` real NOT NULL,
	`ci_low` real NOT NULL,
	`ci_high` real NOT NULL,
	`n_scored` integer NOT NULL,
	`n_repeats` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fidelity_mimic_idx` ON `fidelity` (`mimic_id`,`seq_up_to`);--> statement-breakpoint
CREATE TABLE `identity_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`provider` text NOT NULL,
	`rank` integer NOT NULL,
	`name` text NOT NULL,
	`headline` text,
	`location` text,
	`url` text NOT NULL,
	`summary` text NOT NULL,
	`jev_same_person_p` real,
	`r2_key` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_candidates_mimic_idx` ON `identity_candidates` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`text` text NOT NULL,
	`facet_ids_json` text NOT NULL,
	`evidence_seqs_json` text NOT NULL,
	`confidence` real NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `insights_mimic_idx` ON `insights` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`key` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kg_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`src` text NOT NULL,
	`dst` text NOT NULL,
	`predicate` text NOT NULL,
	`weight` real NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kg_edges_mimic_idx` ON `kg_edges` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `kg_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`props_json` text DEFAULT '{}' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kg_nodes_mimic_idx` ON `kg_nodes` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `mimic_facets` (
	`mimic_id` text NOT NULL,
	`facet_id` text NOT NULL,
	`json` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mimic_id`, `facet_id`)
);
--> statement-breakpoint
CREATE TABLE `mimics` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`display_name` text NOT NULL,
	`location` text NOT NULL,
	`occupation` text,
	`employer` text,
	`links_json` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`identity_state` text NOT NULL,
	`config_hash` text NOT NULL,
	`experiment_id` text,
	`arm` text,
	`consent_app` integer NOT NULL,
	`consent_search` integer NOT NULL,
	`consent_research` integer NOT NULL,
	`split` text NOT NULL,
	`seq_max` integer DEFAULT 0 NOT NULL,
	`snapshot_version` integer DEFAULT 0 NOT NULL,
	`spend_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mimics_participant_idx` ON `mimics` (`participant_id`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text,
	`job_key` text,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`model_snapshot` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`config_hash` text,
	`r2_trace_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_calls_created_idx` ON `model_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `model_calls_mimic_idx` ON `model_calls` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`mimic_id` text NOT NULL,
	`predictor_id` text NOT NULL,
	`role` text NOT NULL,
	`dist_json` text NOT NULL,
	`confidence` real,
	`state_hash` text NOT NULL,
	`evidence_seq_max` integer NOT NULL,
	`config_hash` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model_snapshot` text NOT NULL,
	`cost_usd` real NOT NULL,
	`latency_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`fallback` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `predictions_mimic_idx` ON `predictions` (`mimic_id`);--> statement-breakpoint
CREATE INDEX `predictions_question_role_idx` ON `predictions` (`question_id`,`role`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`seq` integer,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`domain` text NOT NULL,
	`prompt` text NOT NULL,
	`options_json` text NOT NULL,
	`facet_ids_json` text NOT NULL,
	`repeat_of` text,
	`item_key` text,
	`status` text NOT NULL,
	`config_hash` text NOT NULL,
	`prompt_version` text NOT NULL,
	`generator` text NOT NULL,
	`quality_json` text,
	`created_at` integer NOT NULL,
	`served_at` integer
);
--> statement-breakpoint
CREATE INDEX `questions_mimic_idx` ON `questions` (`mimic_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `questions_mimic_seq_idx` ON `questions` (`mimic_id`,`seq`);--> statement-breakpoint
CREATE TABLE `scores` (
	`prediction_id` text PRIMARY KEY NOT NULL,
	`answer_id` text NOT NULL,
	`mimic_id` text NOT NULL,
	`top1` integer NOT NULL,
	`item_acc` real NOT NULL,
	`log_loss` real NOT NULL,
	`brier` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scores_mimic_idx` ON `scores` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`mimic_id` text NOT NULL,
	`version` integer NOT NULL,
	`r2_key` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mimic_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `trait_estimates` (
	`mimic_id` text NOT NULL,
	`facet_id` text NOT NULL,
	`method` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`mean` real NOT NULL,
	`dist_json` text NOT NULL,
	`confidence` real NOT NULL,
	`n_evidence` integer NOT NULL,
	`config_hash` text NOT NULL,
	`model_snapshot` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mimic_id`, `facet_id`, `method`)
);
--> statement-breakpoint
CREATE INDEX `trait_estimates_mimic_idx` ON `trait_estimates` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `trait_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mimic_id` text NOT NULL,
	`facet_id` text NOT NULL,
	`method` text NOT NULL,
	`seq_up_to` integer NOT NULL,
	`mean` real NOT NULL,
	`dist_json` text NOT NULL,
	`confidence` real NOT NULL,
	`n_evidence` integer NOT NULL,
	`config_hash` text NOT NULL,
	`model_snapshot` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trait_history_mimic_idx` ON `trait_history` (`mimic_id`);--> statement-breakpoint
CREATE TABLE `vectors` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`kind` text NOT NULL,
	`facet_ids` text NOT NULL,
	`seq` integer NOT NULL,
	`values_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vectors_mimic_idx` ON `vectors` (`mimic_id`,`kind`);