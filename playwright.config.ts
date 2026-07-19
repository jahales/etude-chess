import { defineConfig, devices } from '@playwright/test'

// Headless E2E — the reliable replacement for eyeballing the app in a browser
// pane (see docs/testing.md). One worker: each test drives the Stockfish WASM
// Worker, so we avoid parallel engine contention.
export default defineConfig({
  testDir: './e2e',
  // Specs that play a game skip without the Maia nets. Convenient locally, a trap
  // in CI — so CI sets REQUIRE_MAIA_NETS=1 and this turns the skip into a failure.
  globalSetup: './e2e/globalSetup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
