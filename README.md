# Vanish Email

[![CI](https://github.com/coldpatch/vanish/actions/workflows/ci.yml/badge.svg)](https://github.com/coldpatch/vanish/actions/workflows/ci.yml)

A simple, lightweight (<550 LOC) Cloudflare Worker that provides a temporary email inbox service that scales with full attachment support.

**Demo:** [https://vanish.host](https://vanish.host)

**API documentation:** `/openapi` endpoint on your deployed worker

## Table of Contents

- [Features](#features)
- [Official Libraries](#official-libraries)
- [Setup Guide](#setup-guide)
  - [Prerequisites](#prerequisites)
  - [Project Setup](#project-setup)
  - [Cloudflare Configuration](#cloudflare-configuration)
    - [D1 Database Setup](#d1-database-setup)
    - [R2 Bucket Setup](#r2-bucket-setup)
    - [Email Routing Setup](#email-routing-setup)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Application Config](#application-config)
- [Running the Worker](#running-the-worker)
  - [Local Development](#local-development)
  - [Deployment](#deployment)
- [Available Scripts](#available-scripts)
- [API Endpoints](#api-endpoints)

---

## Features

- Receives emails via Cloudflare Email Routing
- Stores email data in Cloudflare D1 (SQLite)
- **Attachment Support**: Stores email attachments in Cloudflare R2
- Optional API key authentication
- Auto-generated OpenAPI documentation
- Automatic cleanup of old emails (configurable retention)
- Supports pagination with cursor-based navigation
- Multi-recipient email support

## Official Libraries

Official client libraries are available for multiple languages:

| Language                  | Package                                                                      | Repository                                                    |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **TypeScript/JavaScript** | [`@vanish-email/client`](https://www.npmjs.com/package/@vanish-email/client) | [coldpatch/vanish-ts](https://github.com/coldpatch/vanish-ts) |
| **Python**                | `vanish-py`                                                                  | [coldpatch/vanish-py](https://github.com/coldpatch/vanish-py) |
| **Go**                    | `vanish-go`                                                                  | [coldpatch/vanish-go](https://github.com/coldpatch/vanish-go) |

All libraries are lightweight with zero external dependencies.

---

## Setup Guide

### Prerequisites

Before you begin, ensure you have the following:

- **Bun** (you can use w/e package manager you want): Installed on your system ([bun.sh](https://bun.sh))
- **Cloudflare Account**: With access to Workers, Email Routing, D1, and R2

### Project Setup

1.  **Clone the repository**:

    ```bash
    git clone https://github.com/coldpatch/vanish.git
    cd vanish
    ```

2.  **Install dependencies**:

    ```bash
    bun install
    ```

3.  **Login to Cloudflare**: Authenticate with your Cloudflare account via Wrangler.
    ```bash
    bunx wrangler login
    ```

### Cloudflare Configuration

#### D1 Database Setup

1.  **Create a D1 database**:

    ```bash
    bunx wrangler d1 create vanish
    ```

2.  **Copy the `database_id`** from the output of the above command.

3.  **Update `wrangler.jsonc`**: Replace the `database_id` value with the one you copied and double check the `database_name` (if you use a different name besides vanish, please also update the migrate scripts in `package.json` to match).

4.  **Apply database migrations** (local development):

    ```bash
    bun run migrate
    ```

5.  **Apply database migrations** (production):
    ```bash
    bun run migrate:prod
    ```

#### R2 Bucket Setup

1.  **Create an R2 bucket** for attachments:

    ```bash
    bunx wrangler r2 bucket create vanish
    ```

2.  **Verify** the bucket name in `wrangler.jsonc` matches the one you created:
    ```jsonc
    "r2_buckets": [
        {
            "bucket_name": "vanish",
            "binding": "R2"
        }
    ]
    ```

#### Email Routing Setup

1.  **Go to your Cloudflare Dashboard**: Select your domain.
2.  **Navigate to "Email" → "Email Routing"**.
3.  **Enable Email Routing** if not already enabled.
4.  **Create a Catch-all Rule**:
    - For "Action", choose **"Send to Worker"**
    - Select your Worker (e.g., `vanish`)
    - Click **"Save"**

---

## Configuration

### Environment Variables

Configuration is done via environment variables. Create a `.dev.vars` file for local development based on `.env.example`:

| Variable  | Required | Description                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------- |
| `DOMAINS` | Yes      | Comma-separated list of email domains (e.g., `vanish.host,example.com`)               |
| `API_KEY` | No       | API key for authentication. If set, all endpoints except `/openapi` require this key. |

**Example `.dev.vars`:**

```
DOMAINS=vanish.host,example.com
API_KEY=your-secret-api-key
```

**For production**, set `DOMAINS` in the `vars` section of `wrangler.jsonc`:

```jsonc
"vars": {
    "DOMAINS": "vanish.host"
}
```

**For secrets** (like `API_KEY`), use Wrangler secrets:

```bash
bunx wrangler secret put API_KEY
```

### Application Config

The following settings are configured in `src/index.ts` via the `config` object:

| Setting                  | Default               | Description                                           |
| ------------------------ | --------------------- | ----------------------------------------------------- |
| `retentionMs`            | `43200000` (12 hours) | How long emails are retained before automatic cleanup |
| `maxAttachments`         | `10`                  | Maximum number of attachments per email               |
| `maxAttachmentSize`      | `10485760` (10MB)     | Maximum size per attachment in bytes                  |
| `allowedAttachmentTypes` | Various               | Set of allowed MIME types for attachments             |

**Default Allowed Attachment Types:**

- **Images**: JPEG, PNG, GIF, WebP, SVG
- **Documents**: PDF, TXT, CSV, Word, Excel, PowerPoint
- **Archives**: ZIP, RAR, 7Z
- **Data**: JSON, XML, SQLite
- **Other**: `application/octet-stream`

---

## Running the Worker

### Local Development

To run the worker locally with hot-reloading:

```bash
bun run dev
```

This starts a local development server at `http://localhost:8787`.

### Deployment

To deploy your worker to Cloudflare:

```bash
bun run deploy
```

---

## Available Scripts

| Script                  | Command                | Description                               |
| ----------------------- | ---------------------- | ----------------------------------------- |
| **Development**         | `bun run dev`          | Start local development server            |
| **Start**               | `bun run start`        | Alias for `bun run dev`                   |
| **Deploy**              | `bun run deploy`       | Deploy to Cloudflare Workers              |
| **Test**                | `bun run test`         | Run tests with Vitest (watch mode)        |
| **Test (CI)**           | `bun run test:run`     | Run tests once                            |
| **Lint**                | `bun run lint`         | Run ESLint                                |
| **Lint (Fix)**          | `bun run lint:fix`     | Run ESLint and fix issues                 |
| **Format**              | `bun run format`       | Format code with Prettier                 |
| **Format (Check)**      | `bun run format:check` | Check code formatting                     |
| **Type Check**          | `bun run typecheck`    | Run TypeScript type checking              |
| **Migrate (Local)**     | `bun run migrate`      | Apply D1 migrations locally               |
| **Migrate (Prod)**      | `bun run migrate:prod` | Apply D1 migrations to production         |
| **Generate Migrations** | `bun run generate`     | Generate new migrations with Drizzle Kit  |
| **Push Schema**         | `bun run push`         | Push schema changes directly (dev)        |
| **DB Studio**           | `bun run studio`       | Open Drizzle Kit Studio                   |
| **Type Generation**     | `bun run cf-typegen`   | Generate TypeScript types for CF bindings |

---

## API Endpoints

All endpoints return JSON. Authentication via `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>` header when `API_KEY` is configured.

### Documentation

| Method | Endpoint   | Description                              |
| ------ | ---------- | ---------------------------------------- |
| `GET`  | `/openapi` | OpenAPI specification (no auth required) |

### Domains

| Method | Endpoint   | Description                  |
| ------ | ---------- | ---------------------------- |
| `GET`  | `/domains` | List available email domains |

### Mailbox

| Method   | Endpoint            | Description                                                      |
| -------- | ------------------- | ---------------------------------------------------------------- |
| `GET`    | `/mailbox`          | Generate a unique temporary email address                        |
| `POST`   | `/mailbox`          | Generate a unique temporary email address (with options in body) |
| `GET`    | `/mailbox/:address` | List emails for a mailbox (paginated)                            |
| `DELETE` | `/mailbox/:address` | Delete all emails in a mailbox                                   |

**Query Parameters for `GET /mailbox`:**

- `domain` (optional): Specific domain to use
- `prefix` (optional): Custom prefix for the email address

**Query Parameters for `GET /mailbox/:address`:**

- `limit` (optional): Number of emails to return (1-100, default: 20)
- `cursor` (optional): Pagination cursor for next page

### Email

| Method   | Endpoint     | Description                                          |
| -------- | ------------ | ---------------------------------------------------- |
| `GET`    | `/email/:id` | Get full email details including attachment metadata |
| `DELETE` | `/email/:id` | Delete a specific email and its attachments          |

### Attachments

| Method | Endpoint                               | Description                    |
| ------ | -------------------------------------- | ------------------------------ |
| `GET`  | `/email/:id/attachments/:attachmentId` | Download a specific attachment |

### Response Examples

**`GET /mailbox` Response:**

```json
{
	"email": "abc123def456@vanish.host"
}
```

**`GET /mailbox/:address` Response:**

```json
{
	"data": [
		{
			"id": "550e8400-e29b-41d4-a716-446655440000",
			"from": "sender@example.com",
			"subject": "Hello World",
			"textPreview": "This is the beginning of the email...",
			"receivedAt": "2024-12-29T12:00:00.000Z",
			"hasAttachments": true
		}
	],
	"nextCursor": "1703851200000_550e8400-e29b-41d4-a716-446655440000",
	"total": 42
}
```

**`GET /email/:id` Response:**

```json
{
	"id": "550e8400-e29b-41d4-a716-446655440000",
	"from": "sender@example.com",
	"to": ["recipient@vanish.host"],
	"subject": "Hello World",
	"html": "<p>Hello!</p>",
	"text": "Hello!",
	"receivedAt": "2024-12-29T12:00:00.000Z",
	"hasAttachments": true,
	"attachments": [
		{
			"id": "660e8400-e29b-41d4-a716-446655440001",
			"name": "document.pdf",
			"type": "application/pdf",
			"size": 102400
		}
	]
}
```

---

## Automatic Cleanup

Emails are automatically deleted after the configured retention period (default: 12 hours). The cleanup runs via a scheduled cron job every hour (`0 * * * *`). Both email records and associated R2 attachments are cleaned up.

---

## License

MIT
