// Minimal Playwright config for the EMBER WORKS determinism E2E. CI-ONLY (browsers are not
// installed locally). The spec spins up its own COI server, so no global webServer is configured.

import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'embers.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
