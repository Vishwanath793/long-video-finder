// npx playwright test            (uses the app already running on :3000, or starts it)
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1, // one shared local server and real data: run in order
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-report' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
