ALTER TABLE `model_calls` ADD `attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `predictions` ADD `error_kind` text;--> statement-breakpoint
-- ADR-0036: classify failures stored before error_kind existed. The model's: unusable output (LlmPredictor's two
-- messages; Jev's missing answer or wrong answer type, stored as String(e)) and timeouts; anything else was a call
-- that failed before the model answered.
UPDATE `predictions` SET `error_kind` = CASE
  WHEN `error` IN ('invalid JSON output', 'output does not cover every option') OR `error` GLOB 'missing answer for *' OR `error` GLOB 'Error: Expected *' THEN 'output'
  WHEN `error` GLOB '*aborted due to timeout*' OR `error` GLOB '*TimeoutError*' THEN 'timeout'
  ELSE 'transport'
END WHERE `ok` = 0 AND `error_kind` IS NULL;--> statement-breakpoint
-- ADR-0036: one shadow per question and predictor. Keep the best of any duplicates (ok first, then the earliest).
DELETE FROM `scores` WHERE `prediction_id` IN (SELECT p.`id` FROM `predictions` p WHERE p.`role` = 'shadow' AND EXISTS (SELECT 1 FROM `predictions` o WHERE o.`role` = 'shadow' AND o.`question_id` = p.`question_id` AND o.`predictor_id` = p.`predictor_id` AND o.`id` <> p.`id` AND (o.`ok` > p.`ok` OR (o.`ok` = p.`ok` AND (o.`created_at` < p.`created_at` OR (o.`created_at` = p.`created_at` AND o.`id` < p.`id`))))));--> statement-breakpoint
DELETE FROM `predictions` WHERE `id` IN (SELECT p.`id` FROM `predictions` p WHERE p.`role` = 'shadow' AND EXISTS (SELECT 1 FROM `predictions` o WHERE o.`role` = 'shadow' AND o.`question_id` = p.`question_id` AND o.`predictor_id` = p.`predictor_id` AND o.`id` <> p.`id` AND (o.`ok` > p.`ok` OR (o.`ok` = p.`ok` AND (o.`created_at` < p.`created_at` OR (o.`created_at` = p.`created_at` AND o.`id` < p.`id`))))));--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_shadow_uq` ON `predictions` (`question_id`,`predictor_id`) WHERE "predictions"."role" = 'shadow';