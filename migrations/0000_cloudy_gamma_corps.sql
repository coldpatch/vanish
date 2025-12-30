CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_email_id_idx` ON `attachments` (`email_id`);--> statement-breakpoint
CREATE TABLE `email_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email_id` text NOT NULL,
	`address` text NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_recipients_address_idx` ON `email_recipients` (`address`);--> statement-breakpoint
CREATE INDEX `email_recipients_email_id_idx` ON `email_recipients` (`email_id`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`from` text NOT NULL,
	`to` text DEFAULT '[]' NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emails_received_at_idx` ON `emails` (`received_at`);