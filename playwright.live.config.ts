// Live-Path Gate config (#926). Deliberately separate from playwright.config.ts:
// that config starts its OWN vite on :4173 and its specs install page.route() mocks.
// The Live-Path Gate requires the real running dev instance, real API, real database —
// so there is no webServer here and nothing may be mocked.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/live",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    video: "off",
    screenshot: "off"
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }]
});
