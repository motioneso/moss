import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2450: the Park Office Tasks page on a real instance. Capture a task, edit it in Details,
// prove the edits survive a reload, keep one list selected across List, Grid and the phone
// picker, complete and reopen against the server, and reload into the saved view. Every title
// carries a per-run suffix so the shared, non-reset UAT database stays reusable.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const RUN = Date.now().toString(36);
const LIST_NAME = `UAT Errands ${RUN}`;
const TITLE = `UAT capture ${RUN}`;
const OTHER_TITLE = `UAT other list ${RUN}`;

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

// solo-admin seeds stop before onboarding, so login can land on the first-run wizard.
async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
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

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("Tasks page captures, edits, filters and remembers through the real UI (#2450)", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // A second list gives the index something to select; the list itself is created through the API.
  const created = await api(page, "/api/tasks/lists", "POST", { name: LIST_NAME });
  expect(created.status).toBe(201);
  const listId = created.body.list.id as string;
  const other = await api(page, "/api/tasks", "POST", { title: OTHER_TITLE, listId });
  expect(other.status).toBe(201);

  // Reach Tasks through the app's own navigation, starting from the saved List view.
  expect(
    (await api(page, "/api/tasks/preferences", "PATCH", { defaultView: "priority" })).status
  ).toBe(200);
  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Tasks/ })).toBeVisible();
  const index = page.getByRole("navigation", { name: "Lists" });
  await expect(index.getByRole("button", { name: /^All lists/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Title-only capture.
  const capture = page.getByRole("textbox", { name: "Task title" });
  await capture.fill(TITLE);
  const createdTask = page.waitForResponse(
    (r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST"
  );
  await capture.press("Enter");
  expect((await createdTask).status()).toBe(201);
  await expect(capture).toHaveValue("");
  await expect(page.getByText(TITLE, { exact: true })).toBeVisible();

  // Details: priority, a tag and a subtask, then reload to prove they persisted.
  await page
    .getByRole("button", { name: `Open ${TITLE}` })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue(TITLE);
  const tagInput = dialog.getByRole("textbox", { name: "Add a tag" });
  await tagInput.fill(`uat${RUN}`);
  await tagInput.press("Enter");
  await expect(dialog.getByRole("button", { name: `Remove uat${RUN}` })).toBeVisible();
  const subInput = dialog.getByPlaceholder("Add a subtask and press Enter");
  await subInput.fill(`UAT step ${RUN}`);
  await subInput.press("Enter");
  await expect(dialog.getByRole("button", { name: `Complete UAT step ${RUN}` })).toBeVisible();
  await dialog.getByLabel("Priority").selectOption({ label: "High" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  const high = page.getByRole("region", { name: "High" });
  await expect(high.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(high.getByText(`uat${RUN}`)).toBeVisible();
  await page
    .getByRole("button", { name: `Open ${TITLE}` })
    .first()
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: `Complete UAT step ${RUN}` })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // One list stays selected across List, Grid and the phone picker.
  const listButton = index.getByRole("button", { name: new RegExp(`^${LIST_NAME}`) });
  await listButton.click();
  await expect(listButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByText(OTHER_TITLE, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Do First" })).toBeVisible();
  await expect(listButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(OTHER_TITLE, { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);

  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(index).toBeHidden();
  const picker = page.getByRole("combobox", { name: "Show list" });
  await expect(picker).toHaveValue(listId);
  await noHorizontalOverflow(page);
  await picker.selectOption({ index: 0 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(index.getByRole("button", { name: /^All lists/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText(TITLE, { exact: true })).toBeVisible();

  // Complete and reopen, each confirmed by the server.
  const row = page.locator(".tk-task", { hasText: TITLE }).first();
  const done = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH"
  );
  await row.locator("label.jds-check").click();
  expect((await done).status()).toBe(200);
  const afterDone = await api(page, "/api/tasks");
  const doneTask = (afterDone.body.tasks as Array<{ title: string; status: string }>).find(
    (t) => t.title === TITLE
  );
  expect(doneTask?.status).toBe("done");

  await page.getByRole("button", { name: "Done", exact: true }).click();
  const doneRow = page.locator(".tk-task", { hasText: TITLE }).first();
  const reopened = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH"
  );
  await doneRow.locator("label.jds-check").click();
  expect((await reopened).status()).toBe(200);
  const afterReopen = await api(page, "/api/tasks");
  expect(
    (afterReopen.body.tasks as Array<{ title: string; status: string }>).find(
      (t) => t.title === TITLE
    )?.status
  ).toBe("todo");

  // The chosen view is saved and comes back after a reload.
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Do First" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Do First" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Schedule" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Delegate" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Later" })).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "High" })).toBeVisible();
  await noHorizontalOverflow(page);
});
