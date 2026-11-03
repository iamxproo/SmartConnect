// The 30-user load test (make load-30): one test, the unified backend (E2E_BACKEND=unified, set by the make target)
// started by the browser tests' global setup on its own ports against the disposable test database.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { WEB_URL } from '../e2e/support/stack.js';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: '../e2e/support/stack.ts',
  workers: 1,
  timeout: 20 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(tmpdir(), 'smartconnect-load-results'),
  use: {
    baseURL: WEB_URL,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
