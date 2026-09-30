-- ADR-0036: Persona.md became SOUL.md. Rename in place so existing drafts and curations (with their rev) are kept.
ALTER TABLE `persona_drafts` RENAME TO `soul_drafts`;--> statement-breakpoint
ALTER TABLE `persona_curations` RENAME TO `soul_curations`;--> statement-breakpoint
DROP INDEX IF EXISTS `persona_drafts_mimic_idx`;--> statement-breakpoint
CREATE INDEX `soul_drafts_mimic_idx` ON `soul_drafts` (`mimic_id`,`created_at`);