import { expect, test } from "@playwright/test";
import { createMockConnectorProviders, createMockTask, mockApi } from "./mock-api.js";

// Synthetic browser fixtures verify UI layout; they are not live-path UAT.
const task = createMockTask("task-design", "Review the project notes", {
  description: "Keep the saved context",
  effort: "medium"
});
const list = {
  id: "list-1",
  ownerUserId: "user-1",
  name: "Personal",
  position: 0,
  createdAt: null,
  updatedAt: null
};
for (const width of [320, 390, 768]) {
  test(`task details retain complete fields and footer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: [task],
      taskLists: [list]
    });
    await page.goto("/tasks");
    await page
      .getByRole("button", { name: `Open ${task.title}`, exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Task details" });
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeEnabled();
    const layout = await dialog.evaluate((surface) => {
      const body = surface.querySelector(".jds-dialog__body")!;
      const rect = surface.getBoundingClientRect();
      const actions = [...surface.querySelectorAll(".jds-dialog__foot button")].map((button) => {
        const r = button.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom };
      });
      return {
        bodyWidth: body.clientWidth,
        bodyScroll: body.scrollWidth,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        viewport: innerHeight,
        actions
      };
    });
    expect(layout.bodyScroll).toBeLessThanOrEqual(layout.bodyWidth + 1);
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewport);
    for (const action of layout.actions) {
      expect(action.left).toBeGreaterThanOrEqual(layout.left);
      expect(action.right).toBeLessThanOrEqual(layout.right);
      expect(action.bottom).toBeLessThanOrEqual(layout.bottom);
    }
    expect(
      await dialog
        .locator(".jds-avatar--xs")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    ).toBeGreaterThanOrEqual(11);
    await page.route(`**/api/tasks/${task.id}`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 503, json: { error: "Fixture save failure" } })
        : route.fallback()
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Could not save");
    expect(
      await dialog
        .locator(".jds-dialog__foot")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    ).toBe(true);
  });
}

test("task trailing open action is visible at keyboard focus", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [task],
    taskLists: [list]
  });
  await page.goto("/tasks");
  const title = page.getByRole("button", { name: `Open ${task.title}`, exact: true }).first();
  await title.focus();
  await page.keyboard.press("Tab");
  const trailing = page.locator(".tk-task__open button").first();
  await expect(trailing).toBeFocused();
  await expect(page.locator(".tk-task__open").first()).toHaveCSS("opacity", "1");
});
