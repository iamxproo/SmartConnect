// Browser tests (make e2e): real Chrome against the whole platform started by support/stack.ts on its own ports and
// the disposable test database. Chrome comes from the machine (channel "chrome"): no browser download.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { WEB_URL } from './support/stack.js';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: './support/stack.ts',
  // One worker: the stack is shared and the machine is small; tests isolate themselves with fresh people and orgs.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(tmpdir(), 'smartconnect-e2e-results'),
  use: {
    baseURL: WEB_URL,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
