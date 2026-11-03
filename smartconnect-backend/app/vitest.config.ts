import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The hosted applications are compiled NestJS code: their decorators need the metadata polyfill, as in main.ts.
    setupFiles: ['reflect-metadata'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
