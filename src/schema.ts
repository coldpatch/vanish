import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

export const emails = sqliteTable(
	'emails',
	{
		id: text('id').primaryKey(),
		from: text('from').notNull(),
		html: text('html').notNull(),
		text: text('text').notNull(),
		subject: text('subject').notNull(),
		receivedAt: integer('received_at', { mode: 'timestamp' })
			.$defaultFn(() => new Date())
			.notNull(),
		hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
	},
	(table) => [index('emails_received_at_id_idx').on(table.receivedAt, table.id)],
);

export const emailRecipients = sqliteTable(
	'email_recipients',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		emailId: text('email_id')
			.notNull()
			.references(() => emails.id, { onDelete: 'cascade' }),
		address: text('address').notNull(),
	},
	(table) => [index('email_recipients_addr_email_idx').on(table.address, table.emailId)],
);

export const attachments = sqliteTable(
	'attachments',
	{
		id: text('id').primaryKey(),
		emailId: text('email_id')
			.notNull()
			.references(() => emails.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		type: text('type').notNull(),
		size: integer('size').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [index('attachments_email_id_idx').on(table.emailId)],
);

export type Email = typeof emails.$inferSelect;
export type EmailInsert = typeof emails.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type AttachmentInsert = typeof attachments.$inferInsert;
