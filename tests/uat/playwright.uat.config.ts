import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.JARVIS_UAT_BASE_URL;
const browserName = process.env.MOSS_UAT_BROWSER ?? "chromium";
if (browserName !== "chromium" && browserName !== "firefox") {
  throw new Error(`Unsupported MOSS_UAT_BROWSER: ${browserName}`);
}
const browserDevice =
  browserName === "firefox" ? devices["Desktop Firefox"] : devices["Desktop Chrome"];
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
      name: browserName,
      use: browserDevice
    }
  ]
});
