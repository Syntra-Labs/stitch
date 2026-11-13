import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  globalTimeout: 300_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: new URL('../../verification-output/browser/report', import.meta.url).pathname, open: 'never' }]],
  outputDir: new URL('../../verification-output/browser/results', import.meta.url).pathname,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:8080',
    serviceWorkers: 'block',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'python3 -m http.server 8080 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8080/tests/browser/harness.html',
    cwd: new URL('../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
