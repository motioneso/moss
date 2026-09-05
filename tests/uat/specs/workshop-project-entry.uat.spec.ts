import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test("Workshop creates a private project, retries saved requests and retains messages", async ({
  page
}) => {
  test.setTimeout(120_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  await expect(skip.or(page.locator(".jds-usermenu__trigger")).first()).toBeVisible({
    timeout: 30_000
  });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await page.getByRole("link", { name: "The Workshop", exact: true }).click();
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Workshop live project");
  await page.getByLabel("Your idea", { exact: true }).fill("Keep a private list of book ideas.");
  await page.getByLabel("Already decided").fill("Only save details I choose.");

  // Simulate a lost acknowledgement AFTER the real server commits, then retry in the UI.
  const createKeys: string[] = [];
  await page.route("**/api/workshop/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createKeys.push(route.request().postDataJSON().requestKey);
    const response = await route.fetch();
    if (createKeys.length === 1) {
      expect(response.status()).toBe(201);
      return route.fulfill({ status: 503, json: { error: "Synthetic lost acknowledgement" } });
    }
    expect(response.status()).toBe(200);
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your text is still here");
  await expect(page.getByLabel("Your idea", { exact: true })).toHaveValue(
    "Keep a private list of book ideas."
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workshop live project", exact: true })
  ).toBeVisible();
  expect(createKeys).toHaveLength(2);
  expect(createKeys[1]).toBe(createKeys[0]);
  const projectURL = page.url();
  const projectId = new URL(projectURL).pathname.split("/").at(-1)!;
  expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText("No plan yet", { exact: true })).toBeVisible();

  const message = page.getByLabel("Add to your project", { exact: true });
  await message.fill("Start with the books I already own.");
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const work = page.getByRole("button", { name: "Project work", exact: true });
    if (await work.isVisible()) {
      await work.click();
      await expect(page.getByText("No plan yet", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Conversation", exact: true }).click();
    }
    await expect(message).toHaveValue("Start with the books I already own.");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    ).toBe(true);
  }
  const messageIds: string[] = [];
  await page.route(`**/api/workshop/projects/${projectId}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    messageIds.push(route.request().postDataJSON().messageId);
    const response = await route.fetch();
    if (messageIds.length === 1) {
      expect(response.status()).toBe(201);
      return route.fulfill({ status: 503, json: { error: "Synthetic lost acknowledgement" } });
    }
    expect(response.status()).toBe(200);
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your text is still here");
  await expect(message).toHaveValue("Start with the books I already own.");
  await page.getByRole("button", { name: "Save message", exact: true }).click();
  await expect(message).toHaveValue("");
  expect(messageIds).toHaveLength(2);
  expect(messageIds[1]).toBe(messageIds[0]);
  await page.reload();
  await expect(page.getByText("Start with the books I already own.", { exact: true })).toHaveCount(
    1
  );
  await expect(page.getByText("Saved · awaiting delivery", { exact: true })).toBeVisible();
  const projects = await page.request.get("/api/workshop/projects");
  expect(projects.status()).toBe(200);
  expect((await projects.json()).projects).toHaveLength(1);
  await page.getByRole("link", { name: "← Your projects", exact: true }).click();
  await page.getByRole("link", { name: "Workshop live project", exact: true }).click();
  await expect(page).toHaveURL(projectURL);
});
