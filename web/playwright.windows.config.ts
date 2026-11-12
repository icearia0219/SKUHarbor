import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'windows-host-smoke.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'line',
  outputDir: '../.windows-verification/browser',
  use: {
    browserName: 'chromium',
    channel: process.env.OPENDOT_TEST_BROWSER_CHANNEL || 'msedge',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
