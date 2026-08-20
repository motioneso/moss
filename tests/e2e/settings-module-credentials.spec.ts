// #1759: a module's own sign-ins on the user's settings page.
//
// The credential component and its owner-bound API shipped with #918, but nothing ever rendered
// the user surface, so a slot declared at user scope could not be filled by the person it belonged
// to. A component test cannot catch that — the component always worked. This drives the real
// settings shell, so it fails if the section is unmounted, if the Configure link is missing for a
// module whose only settings are credentials, or if the deep link does not resolve.
import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.js";
import { myModulesResponse } from "./mock-modules.js";

const MODULE_ID = "acme-vault";

test("a module with credentials and no switches is configurable from personal settings", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  // Deliberately hasPreferences:false — this module's ONLY reason to have a settings page is the
  // user-scope credential slot. Before #1759 that combination had no Configure link at all.
  await page.route("**/api/me/modules", async (route) => {
    await route.fulfill({
      json: {
        modules: [
          ...myModulesResponse.modules,
          {
            id: MODULE_ID,
            name: "Acme Vault",
            version: "0.2.0",
            lifecycle: "optional",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: false,
            hasUserCredentials: true
          }
        ]
      }
    });
  });

  await page.route(`**/api/modules/${MODULE_ID}/preferences`, async (route) => {
    await route.fulfill({ json: { preferences: [] } });
  });

  let savedValue: string | null = null;
  await page.route(
    `**/api/me/modules/${MODULE_ID}/credentials/**`,
    async (route, request): Promise<void> => {
      savedValue = (request.postDataJSON() as { value: string }).value;
      await route.fulfill({ json: { credentialId: "api-token", configured: true } });
    }
  );
  await page.route(`**/api/me/modules/${MODULE_ID}/credentials`, async (route) => {
    await route.fulfill({
      json: {
        moduleId: MODULE_ID,
        credentials: [
          {
            credentialId: "api-token",
            displayName: "Acme API token",
            description: null,
            configured: false,
            updatedAt: null
          }
        ],
        instanceManaged: true
      }
    });
  });

  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings categories" });
  await nav.getByRole("button", { name: "Modules" }).click();
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();

  await page.getByRole("button", { name: "Configure Acme Vault" }).click();

  // The card only exists because the user surface is mounted.
  await expect(page.getByText("Your sign-ins")).toBeVisible();
  // instanceManaged:true — the page says out loud that an admin owns the other half.
  await expect(page.getByText("Some settings are managed for the whole instance")).toBeVisible();
  // The module declares no switches, so the "no settings" empty state must not sit above the
  // fields the user came here to fill.
  await expect(page.getByText("This module has no settings")).toHaveCount(0);

  const field = page.getByLabel("Acme API token");
  await expect(field).toBeVisible();
  await field.fill("token-value");
  await page.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => savedValue).toBe("token-value");
});
