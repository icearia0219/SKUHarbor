import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'ecommerce-ops.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'line',
  outputDir: '../artifacts/ecommerce-ops/t9/browser',
  use: {
    browserName: 'chromium',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...(process.platform === 'win32'
      ? { channel: process.env.OPENDOT_TEST_BROWSER_CHANNEL || 'msedge' }
      : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 900 },
  },
});
