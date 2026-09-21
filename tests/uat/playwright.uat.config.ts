import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.JARVIS_UAT_BASE_URL;
if (!baseURL) {
  throw new Error(
    "JARVIS_UAT_BASE_URL is not set — tests/uat/playwright.uat.config.ts must be invoked via " +
      "tests/uat/run-uat.ts (pnpm test:uat), which provisions the ephemeral stack and sets it."
  );
}

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\.uat\.spec\.ts/,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  retries: 0,
  use: {
    baseURL,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    serviceWorkers: "block"
  },
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"]
    }
  ]
});
