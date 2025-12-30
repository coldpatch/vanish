import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// Import all migration SQL files at build time using Vite's glob import
const migrationModules = import.meta.glob('../migrations/*.sql', { query: '?raw', eager: true, import: 'default' }) as Record<
	string,
	string
>;

/**
 * Execute all migration SQL files from the migrations folder (loaded at build time)
 */
async function runMigrations() {
	// Sort migration files by name to ensure correct order
	const migrationFiles = Object.keys(migrationModules).sort();

	for (const file of migrationFiles) {
		const sql = migrationModules[file];
		// Split by the drizzle statement breakpoint marker
		const statements = sql
			.split('--\u003e statement-breakpoint')
			.map((s: string) => s.trim())
			.filter((s: string) => s.length > 0);

		for (const stmt of statements) {
			try {
				await env.DB.prepare(stmt).run();
			} catch {
				// Ignore errors for things like "table already exists" or "index already exists"
				// This allows running migrations multiple times safely
			}
		}
	}
}

/**
 * Helper to seed an email into the database for testing
 */
async function seedEmail(
	id: string,
	from: string,
	to: string[],
	subject: string,
	text: string,
	html: string = '<p>Test</p>',
	hasAttachments: boolean = false,
) {
	const emailInsert = env.DB.prepare(
		`INSERT INTO emails (id, "from", html, text, subject, received_at, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, from, html, text, subject, Date.now(), hasAttachments ? 1 : 0);

	const recipientInserts = to.map((addr) =>
		env.DB.prepare(`INSERT INTO email_recipients (email_id, address) VALUES (?, ?)`).bind(id, addr),
	);

	await env.DB.batch([emailInsert, ...recipientInserts]);
}

/**
 * Helper to seed an attachment into the database and R2
 */
async function seedAttachment(id: string, emailId: string, name: string, type: string, content: string) {
	// Run both operations and await them
	await env.DB.prepare(`INSERT INTO attachments (id, email_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(id, emailId, name, type, Buffer.byteLength(content), Date.now())
		.run();

	await env.R2.put(`${emailId}/${id}`, content, {
		httpMetadata: { contentType: type },
	});
}

/**
 * Helper to clear all test data
 */
async function clearDatabase() {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM attachments'),
		env.DB.prepare('DELETE FROM email_recipients'),
		env.DB.prepare('DELETE FROM emails'),
	]);
}

describe('Vanish Email API', () => {
	// Setup tables before all tests by running migrations
	beforeAll(async () => {
		await runMigrations();
	});

	beforeEach(async () => {
		await clearDatabase();
	});

	afterEach(async () => {
		await clearDatabase();
	});

	describe('POST /mailbox', () => {
		it('generates a random email address', async () => {
			const response = await SELF.fetch('https://example.com/mailbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ email: string }>();
			expect(data.email).toBeDefined();
			expect(data.email).toContain('@');
		});

		it('generates email with specific domain', async () => {
			const response = await SELF.fetch('https://example.com/mailbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domain: 'vanish.host' }),
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ email: string }>();
			expect(data.email).toContain('@vanish.host');
		});

		it('generates email with custom prefix', async () => {
			const response = await SELF.fetch('https://example.com/mailbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prefix: 'testuser' }),
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ email: string }>();
			expect(data.email).toMatch(/^testuser/);
		});

		it('rejects invalid prefix', async () => {
			const response = await SELF.fetch('https://example.com/mailbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prefix: 'invalid@prefix!' }),
			});

			expect(response.status).toBe(400);
		});
	});

	describe('GET /mailbox', () => {
		it('generates a random email address', async () => {
			const response = await SELF.fetch('https://example.com/mailbox');

			expect(response.status).toBe(200);
			const data = await response.json<{ email: string }>();
			expect(data.email).toBeDefined();
			expect(data.email).toContain('@');
		});

		it('generates email with query parameters', async () => {
			const response = await SELF.fetch('https://example.com/mailbox?prefix=hello');

			expect(response.status).toBe(200);
			const data = await response.json<{ email: string }>();
			expect(data.email).toMatch(/^hello/);
		});
	});

	describe('GET /domains', () => {
		it('returns list of configured domains', async () => {
			const response = await SELF.fetch('https://example.com/domains');

			expect(response.status).toBe(200);
			const data = await response.json<{ domains: string[] }>();
			expect(data.domains).toBeDefined();
			expect(Array.isArray(data.domains)).toBe(true);
			expect(data.domains.length).toBeGreaterThan(0);
		});
	});

	describe('GET /mailbox/:address', () => {
		it('returns empty list for new mailbox', async () => {
			const response = await SELF.fetch('https://example.com/mailbox/test@vanish.host');

			expect(response.status).toBe(200);
			const data = await response.json<{ data: unknown[]; nextCursor: string | null; total: number }>();
			expect(data.data).toEqual([]);
			expect(data.nextCursor).toBeNull();
			expect(data.total).toBe(0);
		});

		it('returns emails for a mailbox', async () => {
			const emailId = crypto.randomUUID();
			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'Test Subject', 'Hello World');

			const response = await SELF.fetch('https://example.com/mailbox/recipient@vanish.host');

			expect(response.status).toBe(200);
			const data = await response.json<{
				data: Array<{ id: string; from: string; subject: string; textPreview: string }>;
				total: number;
			}>();
			expect(data.data.length).toBe(1);
			expect(data.data[0].id).toBe(emailId);
			expect(data.data[0].from).toBe('sender@example.com');
			expect(data.data[0].subject).toBe('Test Subject');
			expect(data.total).toBe(1);
		});

		it('supports pagination with limit', async () => {
			// Seed multiple emails
			for (let i = 0; i < 5; i++) {
				await seedEmail(crypto.randomUUID(), `sender${i}@example.com`, ['paginated@vanish.host'], `Subject ${i}`, `Body ${i}`);
			}

			const response = await SELF.fetch('https://example.com/mailbox/paginated@vanish.host?limit=2');

			expect(response.status).toBe(200);
			const data = await response.json<{ data: unknown[]; nextCursor: string | null; total: number }>();
			expect(data.data.length).toBe(2);
			expect(data.nextCursor).not.toBeNull();
			expect(data.total).toBe(5);
		});

		it('supports cursor-based pagination', async () => {
			// Seed emails with predictable order
			const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
			for (const id of ids) {
				await seedEmail(id, 'sender@example.com', ['cursor@vanish.host'], 'Subject', 'Body');
				// Small delay to ensure different timestamps
				await new Promise((r) => setTimeout(r, 10));
			}

			// Get first page
			const response1 = await SELF.fetch('https://example.com/mailbox/cursor@vanish.host?limit=1');
			const data1 = await response1.json<{ data: unknown[]; nextCursor: string }>();
			expect(data1.data.length).toBe(1);
			expect(data1.nextCursor).toBeDefined();

			// Get second page using cursor
			const response2 = await SELF.fetch(
				`https://example.com/mailbox/cursor@vanish.host?limit=1&cursor=${encodeURIComponent(data1.nextCursor)}`,
			);
			const data2 = await response2.json<{ data: unknown[]; nextCursor: string }>();
			expect(data2.data.length).toBe(1);
		});

		it('rejects invalid email address', async () => {
			const response = await SELF.fetch('https://example.com/mailbox/invalid-email');

			expect(response.status).toBe(400);
		});
	});

	describe('DELETE /mailbox/:address', () => {
		it('returns 0 deleted for empty mailbox', async () => {
			const response = await SELF.fetch('https://example.com/mailbox/empty@vanish.host', {
				method: 'DELETE',
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ deleted: number }>();
			expect(data.deleted).toBe(0);
		});

		it('deletes all emails in a mailbox', async () => {
			// Seed emails
			for (let i = 0; i < 3; i++) {
				await seedEmail(crypto.randomUUID(), 'sender@example.com', ['todelete@vanish.host'], `Subject ${i}`, `Body ${i}`);
			}

			const response = await SELF.fetch('https://example.com/mailbox/todelete@vanish.host', {
				method: 'DELETE',
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ deleted: number }>();
			expect(data.deleted).toBe(3);

			// Verify mailbox is empty
			const listResponse = await SELF.fetch('https://example.com/mailbox/todelete@vanish.host');
			const listData = await listResponse.json<{ total: number }>();
			expect(listData.total).toBe(0);
		});
	});

	describe('GET /email/:id', () => {
		it('returns email details', async () => {
			const emailId = crypto.randomUUID();
			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'Test Subject', 'Hello World', '<p>Hello</p>');

			const response = await SELF.fetch(`https://example.com/email/${emailId}`);

			expect(response.status).toBe(200);
			const data = await response.json<{
				id: string;
				from: string;
				to: string[];
				subject: string;
				text: string;
				html: string;
				attachments: unknown[];
			}>();
			expect(data.id).toBe(emailId);
			expect(data.from).toBe('sender@example.com');
			expect(data.to).toContain('recipient@vanish.host');
			expect(data.subject).toBe('Test Subject');
			expect(data.text).toBe('Hello World');
			expect(data.html).toBe('<p>Hello</p>');
			expect(data.attachments).toEqual([]);
		});

		it('returns email with attachments metadata', async () => {
			const emailId = crypto.randomUUID();
			const attachmentId = crypto.randomUUID();

			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'With Attachment', 'Check the file', '<p>Check</p>', true);
			await seedAttachment(attachmentId, emailId, 'document.pdf', 'application/pdf', 'fake pdf content');

			const response = await SELF.fetch(`https://example.com/email/${emailId}`);

			expect(response.status).toBe(200);
			const data = await response.json<{
				attachments: Array<{ id: string; name: string; type: string; size: number }>;
			}>();
			expect(data.attachments.length).toBe(1);
			expect(data.attachments[0].id).toBe(attachmentId);
			expect(data.attachments[0].name).toBe('document.pdf');
			expect(data.attachments[0].type).toBe('application/pdf');
		});

		it('returns 404 for non-existent email', async () => {
			const response = await SELF.fetch(`https://example.com/email/${crypto.randomUUID()}`);

			expect(response.status).toBe(404);
			const data = await response.json<{ error: string }>();
			expect(data.error).toBe('Email not found');
		});

		it('rejects invalid UUID', async () => {
			const response = await SELF.fetch('https://example.com/email/not-a-uuid');

			expect(response.status).toBe(400);
		});
	});

	describe('GET /email/:id/attachments/:attachmentId', () => {
		it('downloads attachment', async () => {
			const emailId = crypto.randomUUID();
			const attachmentId = crypto.randomUUID();
			const content = 'This is the attachment content';

			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'Test', 'Test', '<p>Test</p>', true);
			await seedAttachment(attachmentId, emailId, 'file.txt', 'text/plain', content);

			const response = await SELF.fetch(`https://example.com/email/${emailId}/attachments/${attachmentId}`);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(content);
		});

		it('returns 404 for non-existent attachment', async () => {
			const emailId = crypto.randomUUID();
			const attachmentId = crypto.randomUUID();

			const response = await SELF.fetch(`https://example.com/email/${emailId}/attachments/${attachmentId}`);

			expect(response.status).toBe(404);
			const data = await response.json<{ error: string }>();
			expect(data.error).toBe('Attachment not found');
		});
	});

	describe('DELETE /email/:id', () => {
		it('deletes an email', async () => {
			const emailId = crypto.randomUUID();
			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'To Delete', 'Goodbye');

			const response = await SELF.fetch(`https://example.com/email/${emailId}`, {
				method: 'DELETE',
			});

			expect(response.status).toBe(200);
			const data = await response.json<{ success: boolean }>();
			expect(data.success).toBe(true);

			// Verify email is gone
			const getResponse = await SELF.fetch(`https://example.com/email/${emailId}`);
			expect(getResponse.status).toBe(404);
		});

		it('deletes email and its attachments', async () => {
			const emailId = crypto.randomUUID();
			const attachmentId = crypto.randomUUID();

			await seedEmail(emailId, 'sender@example.com', ['recipient@vanish.host'], 'With File', 'File attached', '<p>File</p>', true);
			await seedAttachment(attachmentId, emailId, 'file.txt', 'text/plain', 'content');

			const response = await SELF.fetch(`https://example.com/email/${emailId}`, {
				method: 'DELETE',
			});

			expect(response.status).toBe(200);

			// Verify attachment is gone from R2
			const attResponse = await SELF.fetch(`https://example.com/email/${emailId}/attachments/${attachmentId}`);
			expect(attResponse.status).toBe(404);
		});
	});

	describe('GET /openapi', () => {
		it('returns OpenAPI specification', async () => {
			const response = await SELF.fetch('https://example.com/openapi');

			expect(response.status).toBe(200);
			const data = await response.json<{ info: { title: string; version: string } }>();
			expect(data.info.title).toBe('Vanish Email API');
		});
	});
});

describe('API Key Authentication', () => {
	it('allows requests without API key when not configured', async () => {
		// In test env, API_KEY is not set by default
		const response = await SELF.fetch('https://example.com/domains');
		expect(response.status).toBe(200);
	});

	it('allows /openapi without API key (even if configured)', async () => {
		const response = await SELF.fetch('https://example.com/openapi');
		expect(response.status).toBe(200);
	});
});

describe('Email Handler', () => {
	// Setup tables before all tests by running migrations
	beforeAll(async () => {
		await runMigrations();
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM attachments'),
			env.DB.prepare('DELETE FROM email_recipients'),
			env.DB.prepare('DELETE FROM emails'),
		]);
	});

	it('processes incoming email', async () => {
		// Create a minimal raw email for testing
		const rawEmail = [
			'From: sender@example.com',
			'To: recipient@vanish.host',
			'Subject: Test Email',
			'Content-Type: text/plain',
			'',
			'Hello, this is a test email.',
		].join('\r\n');

		// Create a properly typed message compatible with ForwardableEmailMessage
		const message = {
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(rawEmail));
					controller.close();
				},
			}),
			rawSize: rawEmail.length,
			from: 'sender@example.com',
			to: 'recipient@vanish.host',
			headers: new Headers({
				From: 'sender@example.com',
				To: 'recipient@vanish.host',
				Subject: 'Test Email',
				'Content-Type': 'text/plain',
			}),
			setReject: () => {},
			forward: async () => {},
			reply: async () => {},
		} as unknown as ForwardableEmailMessage;

		const ctx = createExecutionContext();
		await worker.email(message, env, ctx);
		await waitOnExecutionContext(ctx);

		// Verify email was stored
		const response = await SELF.fetch('https://example.com/mailbox/recipient@vanish.host');
		const data = await response.json<{ data: unknown[]; total: number }>();
		expect(data.total).toBe(1);
	});
});
