import 'dotenv/config';

import { defineConfig } from 'vitest/config';

import { E2E_DATABASE_URL } from './test/e2e-database.js';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // The suites share one database, so they must not interleave writes.
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-only-secret',
    },
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
