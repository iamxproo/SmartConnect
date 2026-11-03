import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS relies on legacy decorators and their emitted design-time metadata (constructor injection,
  // ValidationPipe's DTO types). tsc emits both for the build; this makes Vitest's Oxc transform match.
  // test/decorator-metadata.test.ts fails if it ever stops doing so.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['reflect-metadata'],
    restoreMocks: true,
  },
});
