import { defineConfig } from 'vitest/config';

// Fast unit tests: no database, no Docker (`npm test` / `make test-unit`). Fails if no tests are found.
export default defineConfig({
  test: {
    include: ['unit/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
