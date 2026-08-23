import { test, expect } from "@playwright/test";

import { mockApi } from "./mock-api.js";
import { mockExternalModules } from "./mock-modules.js";

// #996/#860: spec §4c requires an installed registry module to have a working enable/
// disable switch on its own row, not just Remove/Remove+purge. This proves the switch
// renders for installed-enabled rows and round-trips through the same
// setExternalModuleEnabled mutation the External-modules group already uses.
test.describe("Module registry installed-row switch (#996, #860)", () => {
  test("admin can toggle an installed registry module's switch", async ({ page }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    // Seeds "acme-widgets" as a discovered external module (status starts "discovered").
    await mockExternalModules(page);
    await page.route("**/api/admin/module-registry*", async (route) => {
      await route.fulfill({
        json: {
          enabled: true,
          registryUnavailable: false,
          catalogVerification: "verified",
          catalogDigestSha256: "a".repeat(64),
          modules: [
            {
              id: "acme-widgets",
              name: "Acme Widgets",
              state: "installed-enabled",
              installedVersion: "0.1.0",
              latestVersion: "0.1.0",
              purgePending: false,
              capabilities: null,
              description: null,
              lastInstallError: null,
              requiresCore: null
            }
          ]
        }
      });
    });

    await page.goto("/settings");
    await page.getByRole("button", { name: "Admin / Setup" }).click();
    await page.getByRole("button", { name: "Instance modules" }).click();
    await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
    await expect(page.getByText("Module library")).toBeVisible();

    // The authored Switch renders an <input type="checkbox"> (role checkbox, not "switch"),
    // visually hidden — the wrapping <label.jds-switch> is the clickable surface. Starts
    // unchecked: mockExternalModules seeds "acme-widgets" with status "discovered".
    const toggle = page.getByRole("checkbox", { name: /enable acme widgets/i });
    const toggleLabel = page.locator("label.jds-switch", { has: toggle });
    await expect(toggleLabel).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggleLabel.click();
    await expect(page.getByRole("checkbox", { name: /enable acme widgets/i })).toBeChecked();
  });
});
