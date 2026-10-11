import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
const run = Date.now().toString(36);

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}
async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    },
    { path, method, body }
  );
}

// The dedicated UAT stack supplies the real API, worker and database. No route
// interception or fake Moss response is used for any assertion below.
test("planning audit journeys preserve goals, task dates, comments and month navigation", async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page);
  const before = await api(page, "/api/tasks/lists");
  expect(before.status).toBe(200);
  expect(before.body.lists).toHaveLength(0);
  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  const title = `Planning proof ${run}`;
  const createResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST"
  );
  await page.getByRole("textbox", { name: "Task title" }).fill(title);
  await page.getByRole("textbox", { name: "Task title" }).press("Enter");
  const created = await createResponse;
  expect(created.status()).toBe(201);
  const taskId = (await created.json()).task.id as string;
  const navigation = page.getByRole("navigation", { name: "Lists" });
  await expect(navigation.getByRole("button", { name: /^Personal/ })).toBeVisible();
  await expect(page.locator(".tk-task", { hasText: title }).first()).toContainText("Personal");

  const priorLocale = await api(page, "/api/me/locale");
  let goalId: string | null = null;
  try {
    for (const timezone of ["Pacific/Kiritimati", "Pacific/Auckland", "America/Los_Angeles"]) {
      expect(
        (await api(page, "/api/me/locale", "PUT", { timezone, region: "en-US", dateFormat: "24" }))
          .status
      ).toBe(200);
      await page.goto("/tasks");
      await page
        .getByRole("button", { name: `Open ${title}` })
        .first()
        .click();
      let dialog = page.getByRole("dialog", { name: "Task details" });
      await dialog.getByLabel("Due date").fill("2026-11-01");
      await dialog.getByLabel("Reminder", { exact: true }).fill("2026-11-01");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await page
        .getByRole("button", { name: `Open ${title}` })
        .first()
        .click();
      dialog = page.getByRole("dialog", { name: "Task details" });
      await expect(dialog.getByLabel("Due date")).toHaveValue("2026-11-01");
      await expect(dialog.getByLabel("Reminder", { exact: true })).toHaveValue("2026-11-01");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }

    for (const method of ["pointer", "Enter"] as const) {
      const opener = page.getByRole("button", { name: `Open ${title}` }).first();
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Task details" });
      const comment = `Saved ${method} comment ${run}`;
      const response = page.waitForResponse(
        (item) =>
          item.url().endsWith(`/api/tasks/${taskId}/activity`) && item.request().method() === "POST"
      );
      const composer = dialog.getByPlaceholder("Add a comment…");
      await composer.fill(comment);
      if (method === "pointer") await dialog.getByRole("button", { name: "Post comment" }).click();
      else await composer.press("Enter");
      expect((await response).status()).toBe(201);
      await expect(composer).toHaveValue("");
      await expect
        .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      const activity = await api(page, `/api/tasks/${taskId}/activity`);
      expect(activity.body.activity.some((entry: { body: string }) => entry.body === comment)).toBe(
        true
      );
    }

    await page
      .getByRole("button", { name: `Open ${title}` })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Task details" });
    await dialog
      .getByRole("textbox", { name: "Task title" })
      .fill("Unsaved title must survive Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toContainText("Discard unsaved changes?");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue(
      "Unsaved title must survive Escape"
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Discard unsaved changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await api(page, `/api/tasks/${taskId}`)).body.task.title).toBe(title);

    const goalTitle = `Goal reaches Today ${run}`;
    const goal = await api(page, "/api/goals", "POST", {
      title: goalTitle,
      desiredOutcome: "A dependable plan",
      priority: 4
    });
    expect(goal.status).toBe(201);
    goalId = goal.body.id as string;
    const goals = await api(page, "/api/goals");
    expect(Array.isArray(goals.body)).toBe(true);
    expect(goals.body.some((entry: { id: string }) => entry.id === goalId)).toBe(true);
    await page.goto("/today");
    await expect(page.getByText(goalTitle, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(goalTitle, { exact: true })).toBeVisible();

    await page.goto("/calendar");
    await page.evaluate(() => {
      localStorage.setItem("moss.cal.cursor", new Date(2026, 9, 31).toISOString());
      localStorage.setItem("moss.cal.view", "month");
    });
    await page.reload();
    await expect(page.locator(".cal-range")).toHaveText("October 2026");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator(".cal-range")).toHaveText("November 2026");
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.locator(".cal-range")).toHaveText("October 2026");
    await testInfo.attach("planning-journey-assertions", {
      body: JSON.stringify({
        taskId,
        goalId,
        firstList: "Personal",
        dates: ["Pacific/Kiritimati", "Pacific/Auckland", "America/Los_Angeles"],
        comments: ["pointer", "Enter"],
        month: "October → November → October",
        networkInterception: false
      }),
      contentType: "application/json"
    });
  } finally {
    if (priorLocale.status === 200)
      await api(page, "/api/me/locale", "PUT", priorLocale.body.locale);
    await api(page, `/api/tasks/${taskId}`, "PATCH", { status: "archived" });
    if (goalId !== null) await api(page, `/api/goals/${goalId}`, "PATCH", { status: "archived" });
  }
});
