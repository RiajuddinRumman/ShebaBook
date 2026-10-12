import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    // e2e suites need a migrated database; they run through vitest.config.e2e.ts
    exclude: ['**/*.e2e-spec.ts', '**/node_modules/**', '**/dist/**'],
  },
});
