DROP INDEX `email_recipients_address_idx`;--> statement-breakpoint
DROP INDEX `email_recipients_email_id_idx`;--> statement-breakpoint
CREATE INDEX `email_recipients_addr_email_idx` ON `email_recipients` (`address`,`email_id`);--> statement-breakpoint
DROP INDEX `emails_received_at_idx`;--> statement-breakpoint
CREATE INDEX `emails_received_at_id_idx` ON `emails` (`received_at`,`id`);--> statement-breakpoint
ALTER TABLE `emails` DROP COLUMN `to`;