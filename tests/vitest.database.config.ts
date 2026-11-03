import { defineConfig } from 'vitest/config';

// Database infrastructure, permission and tenant-isolation suites, plus the identity/auth integration suites that
// need a real database (`make db-test`).
export default defineConfig({
  // The identity service and gateway are NestJS: legacy decorators with emitted metadata, as their tsc builds have.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['integration/**/*.test.ts', 'security/database/**/*.test.ts'],
    globalSetup: ['./integration/database/global-setup.ts'],
    setupFiles: ['reflect-metadata'],
    fileParallelism: false, // suites share one database instance
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
