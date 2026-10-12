import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';

import {
  E2E_DATABASE_NAME,
  E2E_DATABASE_URL,
  MAINTENANCE_DATABASE_URL,
} from './e2e-database.js';

const run = promisify(execFile);

async function ensureDatabase(): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(E2E_DATABASE_NAME)) {
    throw new Error(`refusing to create database with unsafe name ${E2E_DATABASE_NAME}`);
  }

  const client = new Client({ connectionString: MAINTENANCE_DATABASE_URL });
  await client.connect();
  try {
    const existing = await client.query(
      'select 1 from pg_database where datname = $1',
      [E2E_DATABASE_NAME],
    );
    if (existing.rowCount === 0) {
      // CREATE DATABASE takes no bound parameter; the name is validated above.
      await client.query(`CREATE DATABASE "${E2E_DATABASE_NAME}"`);
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase();
  await run('node_modules/.bin/prisma', ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
  });
}
