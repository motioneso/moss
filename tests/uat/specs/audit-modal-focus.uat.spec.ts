import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signInUatAdmin, requireUatProjectName } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

// Synthetic task/comment text follows the real UI, API and persistence path. No Moss response
// is substituted. This proves shared modal recovery independently of planning date changes.
test("posting through a real task modal keeps Escape and opener focus usable", async ({ page }) => {
  test.setTimeout(180_000);
  if (!requireUatProjectName().startsWith("uat-"))
    throw new Error("Use the isolated UAT provisioner");
  await signInUatAdmin(page);
  await page.goto("/tasks");
  const title = `Modal focus ${randomUUID()}`;
  let taskId: string | undefined;
  try {
    const response = page.waitForResponse(
      (item) => new URL(item.url()).pathname === "/api/tasks" && item.request().method() === "POST"
    );
    await page.getByRole("textbox", { name: "Task title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Task title", exact: true }).press("Enter");
    const created = await response;
    expect(created.status()).toBe(201);
    taskId = (await created.json()).task.id as string;
    for (const method of ["pointer", "Enter"] as const) {
      const opener = page.getByRole("button", { name: `Open ${title}` }).first();
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Task details" });
      const comment = `Declared synthetic ${method} comment`;
      const saved = page.waitForResponse(
        (item) =>
          new URL(item.url()).pathname === `/api/tasks/${taskId}/activity` &&
          item.request().method() === "POST"
      );
      const composer = dialog.getByPlaceholder("Add a comment…");
      await composer.fill(comment);
      if (method === "pointer") await dialog.getByRole("button", { name: "Post comment" }).click();
      else await composer.press("Enter");
      expect((await saved).status()).toBe(201);
      await expect(composer).toHaveValue("");
      await expect
        .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      const activity = await page.request.get(`/api/tasks/${taskId}/activity`);
      expect(activity.ok()).toBe(true);
      expect(
        (await activity.json()).activity.some((entry: { body: string }) => entry.body === comment)
      ).toBe(true);
    }
  } finally {
    // Tasks have no delete route; archiving removes the synthetic task from every list.
    if (taskId) {
      const archived = await page.request.patch(`/api/tasks/${taskId}`, {
        data: { status: "archived" }
      });
      expect(archived.ok()).toBe(true);
    }
  }
});
