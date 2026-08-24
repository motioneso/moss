import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

test("connects Google via the settings flow", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Connected accounts" }).click();
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();

  // With no accounts yet, the service picker is shown immediately.
  await page.getByRole("button", { name: "Google", exact: true }).click();
  await expect(page.getByText("Connect Google")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "client_secret.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        installed: {
          client_id: "cid.apps.googleusercontent.com",
          client_secret: "my-client-secret"
        }
      })
    )
  });
  await expect(page.getByText("Credentials imported from JSON.")).toBeVisible();
  await expect(page.getByLabel("Google client ID")).toHaveValue("cid.apps.googleusercontent.com");
  await expect(page.getByLabel("Google client secret")).toHaveValue("my-client-secret");

  await page.getByLabel("Google client secret").fill("my-client-secret-edited");
  await page.getByRole("button", { name: "Open consent screen" }).click();

  // Once the server returns the auth URL, the step is marked ready.
  await expect(page.getByText("Consent screen ready")).toBeVisible();

  await page
    .getByLabel("Pasted redirect URL")
    .fill("http://localhost:1/?code=4/abc&state=test-state");
  await page.getByRole("button", { name: "Finish connection" }).click();

  // On success the takeover closes and we return to the accounts list.
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  await expect(page.getByText("Connect Google")).not.toBeVisible();
});
