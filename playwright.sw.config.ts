import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/sw",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"]
    }
  ],
  webServer: {
    command:
      "pnpm --filter @moss/web build && pnpm --filter @moss/web exec vite preview --host 127.0.0.1 --port 4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:4174"
  }
});
