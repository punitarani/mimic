CREATE TABLE `answer_rewinds` (
	`id` text PRIMARY KEY NOT NULL,
	`mimic_id` text NOT NULL,
	`question_id` text NOT NULL,
	`seq` integer NOT NULL,
	`answer_id` text NOT NULL,
	`value` text NOT NULL,
	`why` text,
	`latency_ms` integer NOT NULL,
	`revealed_prediction` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`answered_at` integer NOT NULL,
	`rewound_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `answer_rewinds_mimic_idx` ON `answer_rewinds` (`mimic_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `answer_rewinds_answer_idx` ON `answer_rewinds` (`answer_id`);--> statement-breakpoint
CREATE INDEX `answer_rewinds_idempotency_idx` ON `answer_rewinds` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `facts` ADD `seq_up_to` integer;--> statement-breakpoint
ALTER TABLE `insights` ADD `superseded_seq` integer;--> statement-breakpoint
ALTER TABLE `mimics` ADD `evidence_epoch` integer DEFAULT 0 NOT NULL;