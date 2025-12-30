import { Hono } from 'hono';
import PostalMime, { Attachment } from 'postal-mime';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, or, lt, inArray, desc, count } from 'drizzle-orm';
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi';
import { z } from 'zod';
import * as schema from './schema';
import { AttachmentInsert, attachments, emails, emailRecipients } from './schema';

export const config = {
	title: 'Vanish Email API',
	version: '0.0.1a',
	description: 'Temporary email service API for receiving and managing disposable email addresses.',
	retentionMs: 12 * 60 * 60 * 1000,

	maxAttachments: 10,
	maxAttachmentSize: 10 * 1024 * 1024,

	allowedAttachmentTypes: new Set([
		'image/jpeg',
		'image/png',
		'image/gif',
		'image/webp',
		'image/svg+xml',
		'application/pdf',
		'text/plain',
		'text/csv',
		'application/msword',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.ms-excel',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		'application/vnd.ms-powerpoint',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		'application/zip',
		'application/x-rar-compressed',
		'application/x-7z-compressed',
		'application/x-sqlite3',
		'application/vnd.sqlite3',
		'application/json',
		'application/xml',
		'text/xml',
		'application/octet-stream',
	]),
} as const;

const app = new Hono<{ Bindings: Env & { API_KEY?: string } }>();

app.use('*', async (c, next) => {
	if (c.env.DOMAINS.split(',').length === 0) {
		return c.json({ error: 'No domains configured' }, 500);
	}
	if (c.req.path === '/openapi' || !c.env.API_KEY) return next();

	const provided = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || c.req.header('X-API-Key');

	if (provided !== c.env.API_KEY) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	return next();
});

app.get('/openapi', async (c) => {
	const urlObj = new URL(c.req.url);
	const handler = openAPIRouteHandler(app, {
		documentation: {
			info: {
				title: config.title,
				version: config.version,
				description: config.description,
			},
			servers: [{ url: `${urlObj.protocol}//${urlObj.host}`, description: 'Current server' }],
		},
	});
	return handler(c, async () => {});
});

const EmailSummary = z.object({
	id: z.uuid(),
	from: z.email(),
	subject: z.string(),
	textPreview: z.string(),
	receivedAt: z.string(),
	hasAttachments: z.boolean(),
});

const AttachmentMeta = z.object({
	id: z.uuid(),
	name: z.string(),
	type: z.string(),
	size: z.number().int(),
});

const EmailDetail = z.object({
	id: z.uuid(),
	from: z.email(),
	to: z.array(z.email()),
	subject: z.string(),
	html: z.string(),
	text: z.string(),
	receivedAt: z.string(),
	hasAttachments: z.boolean(),
	attachments: z.array(AttachmentMeta),
});

const PaginatedEmailList = z.object({
	data: z.array(EmailSummary),
	nextCursor: z.string().nullable(),
	total: z.number().int(),
});

const GeneratedEmail = z.object({
	email: z.email(),
});

const SuccessResponse = z.object({ success: z.boolean() });
const DeletedResponse = z.object({ deleted: z.number().int() });
const ErrorResponse = z.object({ error: z.string() });
const createDb = (d1: D1Database) => drizzle(d1, { schema });

type Database = ReturnType<typeof createDb>;
type ValidAttachment = { attachment: Attachment; contentType: string; size: number };

app.post(
	'/mailbox',
	describeRoute({
		tags: ['Email'],
		summary: 'Generate a unique temporary email address',
		description: 'Creates a new unique email address using a random UUID and one of the configured domains.',
		responses: {
			200: { description: 'Generated email address', content: { 'application/json': { schema: resolver(GeneratedEmail) } } },
		},
	}),
	validator(
		'json',
		z
			.object({
				domain: z.string().optional(),
				prefix: z
					.string()
					.min(1)
					.max(64)
					.regex(/^[a-z0-9._-]+$/i)
					.optional(),
			})
			.optional(),
	),
	(c) => {
		const body = c.req.valid('json') ?? {};
		const domains = c.env.DOMAINS.split(',');
		return c.json({
			email: generateUniqueEmailAddress(body.domain ?? domains[Math.floor(Math.random() * domains.length)], domains, body.prefix),
		});
	},
);

app.get(
	'/mailbox',
	describeRoute({
		tags: ['Email'],
		summary: 'Generate a unique temporary email address',
		responses: {
			200: { description: 'Generated email address', content: { 'application/json': { schema: resolver(GeneratedEmail) } } },
		},
	}),
	validator(
		'query',
		z.object({
			domain: z.string().optional(),
			prefix: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[a-z0-9._-]+$/i)
				.optional(),
		}),
	),
	(c) => {
		const { domain, prefix } = c.req.valid('query');
		const domains = c.env.DOMAINS.split(',');
		return c.json({ email: generateUniqueEmailAddress(domain ?? domains[Math.floor(Math.random() * domains.length)], domains, prefix) });
	},
);

app.get(
	'/domains',
	describeRoute({
		tags: ['Email'],
		summary: 'List available email domains',
		responses: {
			200: {
				description: 'List of domains',
				content: { 'application/json': { schema: resolver(z.object({ domains: z.array(z.string()) })) } },
			},
		},
	}),
	(c) => c.json({ domains: c.env.DOMAINS.split(',') }),
);

app.get(
	'/mailbox/:address',
	describeRoute({
		tags: ['Mailbox'],
		summary: 'List emails for a mailbox',
		description: 'Returns paginated list of emails received at the given address.',
		responses: {
			200: { description: 'Paginated email list', content: { 'application/json': { schema: resolver(PaginatedEmailList) } } },
		},
	}),
	validator('param', z.object({ address: z.string().email() })),
	validator(
		'query',
		z.object({
			limit: z.coerce.number().int().min(1).max(100).default(20),
			cursor: z.string().optional(),
		}),
	),
	async (c) => {
		const { address } = c.req.valid('param');
		const { limit, cursor } = c.req.valid('query');
		const db = createDb(c.env.DB);
		const parsedCursor = parseCursor(cursor);

		const cursorCondition = parsedCursor
			? or(lt(emails.receivedAt, parsedCursor.ts), and(eq(emails.receivedAt, parsedCursor.ts), lt(emails.id, parsedCursor.id)))
			: undefined;

		const [countResult, results] = await Promise.all([
			db.select({ count: count() }).from(emailRecipients).where(eq(emailRecipients.address, address)),
			db
				.select({
					id: emails.id,
					from: emails.from,
					text: emails.text,
					subject: emails.subject,
					receivedAt: emails.receivedAt,
					hasAttachments: emails.hasAttachments,
				})
				.from(emails)
				.innerJoin(emailRecipients, eq(emails.id, emailRecipients.emailId))
				.where(and(eq(emailRecipients.address, address), cursorCondition))
				.orderBy(desc(emails.receivedAt), desc(emails.id))
				.limit(limit + 1),
		]);

		const total = countResult[0]?.count ?? 0;
		const hasMore = results.length > limit;
		const items = hasMore ? results.slice(0, limit) : results;
		const nextCursor = hasMore && items.length > 0 ? encodeCursor(items[items.length - 1] as schema.Email) : null;

		return c.json({
			data: items.map((e) => ({
				id: e.id,
				from: e.from,
				textPreview: e.text.slice(0, 100),
				subject: e.subject,
				receivedAt: e.receivedAt,
				hasAttachments: e.hasAttachments,
			})),
			nextCursor,
			total,
		});
	},
);

app.delete(
	'/mailbox/:address',
	describeRoute({
		tags: ['Mailbox'],
		summary: 'Delete all emails in a mailbox',
		responses: {
			200: { description: 'Deletion result', content: { 'application/json': { schema: resolver(DeletedResponse) } } },
		},
	}),
	validator('param', z.object({ address: z.string().email() })),
	async (c) => {
		const { address } = c.req.valid('param');
		const db = createDb(c.env.DB);

		const mailboxEmails = await db
			.select({ id: emailRecipients.emailId })
			.from(emailRecipients)
			.where(eq(emailRecipients.address, address));

		if (mailboxEmails.length === 0) return c.json({ deleted: 0 });

		const emailIds = mailboxEmails.map((e) => e.id);
		const allAtts = await db
			.select({ id: attachments.id, emailId: attachments.emailId })
			.from(attachments)
			.where(inArray(attachments.emailId, emailIds));

		await Promise.all([
			allAtts.length > 0 ? c.env.R2.delete(allAtts.map((a) => `${a.emailId}/${a.id}`)) : Promise.resolve(),
			db.delete(emails).where(inArray(emails.id, emailIds)),
		]);

		return c.json({ deleted: emailIds.length });
	},
);

app.get(
	'/email/:id',
	describeRoute({
		tags: ['Email'],
		summary: 'Get email details',
		responses: {
			200: { description: 'Email details with attachments', content: { 'application/json': { schema: resolver(EmailDetail) } } },
			404: { description: 'Email not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
		},
	}),
	validator('param', z.object({ id: z.string().uuid() })),
	async (c) => {
		const { id } = c.req.valid('param');
		const db = createDb(c.env.DB);

		const [[email], recipients, atts] = await Promise.all([
			db.select().from(emails).where(eq(emails.id, id)).limit(1),
			db.select({ address: emailRecipients.address }).from(emailRecipients).where(eq(emailRecipients.emailId, id)),
			db
				.select({ id: attachments.id, name: attachments.name, type: attachments.type, size: attachments.size })
				.from(attachments)
				.where(eq(attachments.emailId, id)),
		]);

		if (!email) return c.json({ error: 'Email not found' }, 404);

		return c.json({ ...email, to: recipients.map((r) => r.address), attachments: atts });
	},
);

app.get(
	'/email/:id/attachments/:attachmentId',
	describeRoute({
		tags: ['Attachments'],
		summary: 'Download attachment',
		responses: {
			200: { description: 'Attachment file stream' },
			404: { description: 'Attachment not found', content: { 'application/json': { schema: resolver(ErrorResponse) } } },
		},
	}),
	validator('param', z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() })),
	async (c) => {
		const { id, attachmentId } = c.req.valid('param');
		const object = await c.env.R2.get(`${id}/${attachmentId}`);
		if (!object) return c.json({ error: 'Attachment not found' }, 404);

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		return new Response(object.body, { headers });
	},
);

app.delete(
	'/email/:id',
	describeRoute({
		tags: ['Email'],
		summary: 'Delete an email',
		responses: {
			200: { description: 'Email deleted', content: { 'application/json': { schema: resolver(SuccessResponse) } } },
		},
	}),
	validator('param', z.object({ id: z.string().uuid() })),
	async (c) => {
		const { id } = c.req.valid('param');
		const db = createDb(c.env.DB);

		const atts = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.emailId, id));
		await Promise.all([
			atts.length > 0 ? c.env.R2.delete(atts.map((a) => `${id}/${a.id}`)) : Promise.resolve(),
			db.delete(attachments).where(eq(attachments.emailId, id)),
			db.delete(emails).where(eq(emails.id, id)),
		]);

		return c.json({ success: true });
	},
);

export default {
	fetch: app.fetch,

	async email(message, env, ctx) {
		const email = await PostalMime.parse(message.raw);
		const fromAddress = email.from?.address;
		const toAddresses = email.to?.filter((t) => t.address).map((t) => t.address!);
		if (!fromAddress || !toAddresses || toAddresses.length === 0) return;

		const db = createDb(env.DB);
		const validAttachments = sanitizeAttachments(email.attachments || []);
		const emailId = crypto.randomUUID();

		await db.batch([
			db.insert(emails).values({
				id: emailId,
				from: fromAddress,
				subject: email.subject ?? '',
				html: email.html ?? '',
				text: email.text ?? '',
				hasAttachments: validAttachments.length > 0,
			}),
			db.insert(emailRecipients).values(
				toAddresses.map((addr) => ({
					emailId,
					address: addr,
				})),
			),
		]);

		if (validAttachments.length > 0) {
			ctx.waitUntil(saveAttachmentsBatch(validAttachments, emailId, env.R2, db));
		}
	},

	async scheduled(event, env, ctx) {
		if (event.cron !== '0 * * * *') return;

		ctx.waitUntil(
			(async () => {
				const db = createDb(env.DB);
				const cutoffDate = new Date(Date.now() - config.retentionMs);
				const emailsToDelete = await db.select({ id: emails.id }).from(emails).where(lt(emails.receivedAt, cutoffDate));

				if (emailsToDelete.length === 0) return;

				const emailIds = emailsToDelete.map((e) => e.id);

				const deletedAtts = await db
					.select({ id: attachments.id, emailId: attachments.emailId })
					.from(attachments)
					.where(inArray(attachments.emailId, emailIds));

				await db.delete(emails).where(inArray(emails.id, emailIds));

				if (deletedAtts.length > 0) {
					await env.R2.delete(deletedAtts.map((a) => `${a.emailId}/${a.id}`));
				}
			})(),
		);
	},
} satisfies ExportedHandler<Env>;

function parseCursor(cursor?: string): { ts: Date; id: string } | null {
	if (!cursor) return null;
	const idx = cursor.indexOf('_');
	if (idx === -1) return null;
	const ts = parseInt(cursor.slice(0, idx), 10);
	const id = cursor.slice(idx + 1);
	return isNaN(ts) ? null : { ts: new Date(ts), id };
}

function encodeCursor(email: schema.Email): string {
	return `${email.receivedAt.getTime()}_${email.id}`;
}

function getAttachmentSize(content: string | ArrayBuffer | Uint8Array): number {
	return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

function sanitizeAttachments(atts: Attachment[]): ValidAttachment[] {
	return atts.slice(0, config.maxAttachments).reduce<ValidAttachment[]>((valid, att) => {
		if (!att.filename) return valid;
		const contentType = att.mimeType || 'application/octet-stream';
		if (!config.allowedAttachmentTypes.has(contentType)) return valid;
		const size = getAttachmentSize(att.content);
		if (size > config.maxAttachmentSize) return valid;
		valid.push({ attachment: att, contentType, size });
		return valid;
	}, []);
}

async function saveAttachmentsBatch(validAttachments: ValidAttachment[], emailId: string, r2: R2Bucket, db: Database): Promise<void> {
	const records: AttachmentInsert[] = [];
	const r2Uploads: Promise<R2Object | null>[] = [];

	for (const { attachment, contentType, size } of validAttachments) {
		const id = crypto.randomUUID();
		const filename = attachment.filename!;
		records.push({ id, emailId, name: filename, type: contentType, size });
		r2Uploads.push(
			r2.put(`${emailId}/${id}`, attachment.content, {
				httpMetadata: { contentType, contentDisposition: `attachment; filename="${filename}"` },
				customMetadata: { originalFilename: filename, uploadedAt: Date.now().toString() },
			}),
		);
	}

	await Promise.all([db.insert(attachments).values(records), ...r2Uploads]);
}

function generateUniqueEmailAddress(domain: string, domains: string[], prefix?: string): string {
	const selectedDomain = domain ?? domains[Math.floor(Math.random() * domains.length)];
	const localPart = `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
	// TODO: validate email address is unique before returning it
	return `${localPart}@${selectedDomain}`;
}
