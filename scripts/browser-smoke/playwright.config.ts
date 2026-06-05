// Minimal Playwright config for the ecsia browser smoke. CI-ONLY (browsers are not installed locally).
// The spec spins up its own per-variant servers, so no global webServer is configured here.

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'playwright.spec.ts',
  fullyParallel: false, // one tab at a time — resource-safe, deterministic
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
