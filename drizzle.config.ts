import { defineConfig } from 'drizzle-kit';

import fs from 'fs';
import path from 'path';

const getLocalD1 = () => {
	const basePath = path.resolve('.wrangler');
	const dbFile = fs
		.readdirSync(basePath, { encoding: 'utf-8', recursive: true })
		.find((f) => f.endsWith('.sqlite') && f.toLowerCase().includes('d1'));

	if (!dbFile) {
		throw new Error(`D1 database file not found in ${basePath} - have you created and attached a D1 database to this project?`);
	}

	const url = path.resolve(basePath, dbFile);
	return url;
};

export default defineConfig({
	schema: './src/schema.ts',

	verbose: true,
	strict: true,
	dialect: 'sqlite',
	out: './migrations',
	dbCredentials: {
		url: getLocalD1(),
	},
});
