import { expect, test } from "@playwright/test";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";

const project = {
  id: "11111111-2222-4333-8444-555555555555",
  title: "A reading list for quieter weekends",
  initialRequest: "Keep notes about the books I want to read.",
  context: "Synthetic presentation fixture",
  createdAt: "2026-09-10T12:00:00Z",
  updatedAt: "2026-09-10T12:00:00Z"
};

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1440, height: 1000 }
]) {
  test(`conversation fits the actual host row at ${viewport.width}x${viewport.height}`, async ({
    page,
    context
  }) => {
    await page.setViewportSize(viewport);
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });
    await page.route("**/api/workshop/projects?*", (route) =>
      route.fulfill({ json: { projects: [project], nextCursor: null } })
    );
    await page.route(`**/api/workshop/projects/${project.id}`, (route) =>
      route.fulfill({ json: { project } })
    );
    await page.route(`**/api/workshop/projects/${project.id}/messages?*`, (route) =>
      route.fulfill({ json: { entries: [], nextCursor: "0" } })
    );
    await page.goto(`/workshop/${project.id}`);
    const composer = page.getByRole("textbox", { name: "Add to your project" });
    await expect(composer).toBeVisible();
    const withinViewport = async () => {
      const bounds = await composer.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    };
    await withinViewport();
    await composer.fill("Keep this unsent draft");
    await context.setOffline(true);
    await expect(
      page.getByText("You’re offline. Your unsent text stays here.", { exact: false })
    ).toBeVisible();
    await expect(composer).toHaveValue("Keep this unsent draft");
    await withinViewport();
    await context.setOffline(false);
    await page.goto("/workshop");
    await expect(page.getByRole("heading", { name: "Your Projects" })).toBeVisible();
    await expect(page.locator(".workshop-page--conversation")).toHaveCount(0);
    await page.getByRole("link", { name: project.title }).click();
    await expect(composer).toBeVisible();
    await withinViewport();
  });
}
