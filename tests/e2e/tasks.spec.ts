import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, createMockTask, mockApi } from "./mock-api.js";

const urgentTag = {
  id: "tag-urgent",
  ownerUserId: "user-1",
  listId: "list-1",
  name: "urgent",
  createdAt: null
};

const personalList = {
  id: "list-1",
  ownerUserId: "user-1",
  name: "Personal",
  position: 0,
  createdAt: null,
  updatedAt: null
};
const errandsList = { ...personalList, id: "list-2", name: "Errands", position: 1 };

test.beforeEach(async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    taskLists: [personalList, errandsList],
    tasks: [
      createMockTask("t-critical", "File taxes", {
        priority: 5,
        dueAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
      }),
      createMockTask("t-someday", "Learn cello", {
        priority: 1,
        listId: "list-2",
        tags: [urgentTag]
      })
    ]
  });
});

test("priority view groups tasks by priority level", async ({ page }) => {
  await page.goto("/tasks");
  // Default filter is "todo" so both tasks (status: "todo") should appear
  // List view is backed by the priority-grouped view model by default.
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText("Critical")).toBeVisible();
  await expect(page.getByText("File taxes")).toBeVisible();
});

test("grid toggle switches to the grid view", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Grid", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText("Do First")).toBeVisible();
});

test("grid shows four ruled quadrant sections with counts and keeps the index", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Grid", exact: true }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Do First",
    "Schedule",
    "Delegate",
    "Later"
  ]);
  const doFirst = page.getByRole("region", { name: "Do First" });
  await expect(doFirst.getByText("1 task", { exact: true })).toBeVisible();
  await expect(doFirst.getByText("File taxes")).toBeVisible();
  const schedule = page.getByRole("region", { name: "Schedule" });
  await expect(schedule.getByText("0 tasks", { exact: true })).toBeVisible();
  await expect(schedule.getByText("Nothing here.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Later" }).getByText("Learn cello")).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Lists" })).toBeVisible();

  await doFirst.getByRole("button", { name: "Open File taxes" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("grid stacks to one column on a phone without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const doFirst = page.getByRole("region", { name: "Do First" });
  const schedule = page.getByRole("region", { name: "Schedule" });
  const [a, b] = [await doFirst.boundingBox(), await schedule.boundingBox()];
  expect(a && b && b.y >= a.y + a.height).toBe(true);
  for (const region of [doFirst, schedule]) {
    const box = await region.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  }
});

test("suggested tasks can be accepted from the grid", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    taskLists: [personalList],
    tasks: [createMockTask("t-suggested", "Book the dentist", { status: "suggested" })]
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.getByRole("button", { name: "Suggested", exact: true }).click();
  const later = page.getByRole("region", { name: "Later" });
  const patch = page.waitForRequest((req) => req.method() === "PATCH");
  await later.getByRole("button", { name: "Accept" }).click();
  expect((await patch).postDataJSON()).toMatchObject({ status: "todo" });
});

test("assigning a tag from the task modal renders a chip", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open File taxes" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Suggestion chips appear for tags not yet assigned; clicking one assigns the tag.
  await page.getByRole("button", { name: "#urgent" }).click();
  // The assigned tag renders as a removable chip.
  await expect(page.getByRole("button", { name: "Remove urgent" })).toBeVisible();
});

test("a tag is never filed before the task loads, then lands in the task's own list", async ({
  page
}) => {
  let releaseTask: () => void = () => {};
  const taskGate = new Promise<void>((resolve) => (releaseTask = resolve));
  await page.route("**/api/tasks/t-someday", async (route) => {
    await taskGate;
    await route.fallback();
  });
  const tagPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/tasks\/lists\/[^/]+\/tags$/.test(request.url())) {
      tagPosts.push(request.url());
    }
  });

  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open Learn cello" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  const tagInput = dialog.getByRole("textbox", { name: "Add a tag" });
  await tagInput.fill("cellist");
  await tagInput.press("Enter");
  expect(tagPosts).toEqual([]);

  releaseTask();
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue("Learn cello");
  await tagInput.fill("cellist");
  await tagInput.press("Enter");
  await expect(dialog.getByRole("button", { name: "Remove cellist" })).toBeVisible();
  expect(tagPosts).toEqual([expect.stringContaining("/api/tasks/lists/list-2/tags")]);
});

test("task details window is named, closes on Escape and returns focus", async ({ page }) => {
  await page.goto("/tasks");
  const opener = page.getByRole("button", { name: "Open File taxes" }).first();
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("opening task details moves keyboard focus inside the window", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open File taxes" }).first().focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toHaveValue("File taxes");
  await expect(dialog.getByRole("textbox", { name: "Task title" })).toBeFocused();
});

test("Escape in the status menu closes only the menu and keeps unsaved edits", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open File taxes" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  const title = dialog.getByRole("textbox", { name: "Task title" });
  await expect(title).toHaveValue("File taxes");
  await title.fill("File taxes early");
  const more = dialog.getByRole("button", { name: "More status options" });
  await more.click();
  await expect(dialog.getByRole("button", { name: "Archive" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue("File taxes early");
  await expect(more).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("list index shows no counts while tasks are unavailable, never zero", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let failing = true;
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "GET" && failing ? route.fulfill(serverError) : route.fallback()
  );
  await page.goto("/tasks");
  await expect(page.getByRole("alert")).toContainText("Could not load your tasks");
  const index = page.getByRole("navigation", { name: "Lists" });
  await expect(index.getByRole("button", { name: "All lists", exact: true })).toBeVisible();
  await expect(index.getByRole("button", { name: "Personal", exact: true })).toBeVisible();
  await expect(index.getByRole("button", { name: "Errands", exact: true })).toBeVisible();
  await expect(index.locator(".jds-navindex__count")).toHaveCount(0);
  await index.getByRole("button", { name: "List filters" }).click();
  await expect(index.locator(".tk-tagmenu__item", { hasText: "Errands" })).toBeVisible();
  await expect(index.locator(".tk-tagmenu__item .ct")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  const picker = page.getByRole("combobox", { name: "Show list" });
  await expect(picker.locator("option")).toHaveText(["All lists", "Personal", "Errands"]);

  failing = false;
  await page.getByRole("button", { name: "Retry" }).first().click();
  await expect(picker.locator("option")).toHaveText([
    "All lists (2)",
    "Personal (1)",
    "Errands (1)"
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    index.getByRole("button", { name: "All lists, 2 tasks" })
  ).toHaveAccessibleDescription(/before search/);
});

test("list index focuses one list and All lists resets", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  const index = page.getByRole("navigation", { name: "Lists" });
  await expect(index.getByRole("button", { name: "All lists, 2 tasks" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  await index.getByRole("button", { name: "Errands, 1 task" }).click();
  await expect(index.getByRole("button", { name: "Errands, 1 task" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText("File taxes")).toHaveCount(0);
  await expect(page.getByText("Learn cello")).toBeVisible();

  await index.getByRole("button", { name: "All lists, 2 tasks" }).click();
  await expect(page.getByText("File taxes")).toBeVisible();
});

test("list selection survives switching between List and Grid", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  const index = page.getByRole("navigation", { name: "Lists" });
  await index.getByRole("button", { name: "Errands, 1 task" }).click();

  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByText("Do First")).toBeVisible();
  await expect(index.getByRole("button", { name: "Errands, 1 task" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText("File taxes")).toHaveCount(0);
  await expect(page.getByText("Learn cello")).toBeVisible();
});

test("List filters menu can hide a list and the index says so", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  const index = page.getByRole("navigation", { name: "Lists" });
  await index.getByRole("button", { name: "List filters" }).click();
  // Two clicks cycle a list from shown, to show only, to hidden.
  await page.locator(".tk-tagmenu__item", { hasText: "Personal" }).click();
  await page.locator(".tk-tagmenu__item", { hasText: "Personal" }).click();

  await expect(index.getByRole("status")).toHaveText("1 list hidden");
  await expect(index.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByText("File taxes")).toHaveCount(0);
});

test("phone width swaps the index for a list picker with the same state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tasks");
  await expect(page.getByRole("navigation", { name: "Lists" })).toBeHidden();
  const picker = page.getByRole("combobox", { name: "Show list" });
  await picker.selectOption({ label: "Errands (1)" });
  await expect(page.getByText("File taxes")).toHaveCount(0);

  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(picker).toHaveValue("list-2");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("navigation", { name: "Lists" }).getByRole("button", { name: "Errands, 1 task" })
  ).toHaveAttribute("aria-pressed", "true");
});

test("tag filter narrows visible tasks and can be cleared", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByPlaceholder("Filter by tag…").click();
  await page.getByRole("button", { name: /urgent/ }).click();

  await expect(page.getByRole("button", { name: "Remove urgent" })).toBeVisible();
  await expect(page.getByText("File taxes")).toHaveCount(0);
  await expect(page.getByText("Learn cello")).toBeVisible();

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("File taxes")).toBeVisible();
});

test("task dialog selects use the canonical select wrapper", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open File taxes" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // List, Priority, and Repeats selects each render inside .jds-selectwrap
  // (visible chevron affordance) instead of as bare <select> elements.
  await expect(dialog.locator(".jds-selectwrap select.jds-select")).toHaveCount(3);
  await expect(dialog.locator("select:not(.jds-select)")).toHaveCount(0);
});

test("priority groups are headed sections with task counts", async ({ page }) => {
  await page.goto("/tasks");
  const headings = page.getByRole("heading", { level: 2 });
  await expect(headings).toHaveText(["Critical", "Someday"]);
  const critical = page.getByRole("region", { name: "Critical" });
  await expect(critical.getByText("1 task", { exact: true })).toBeVisible();
  await expect(critical.getByText("File taxes")).toBeVisible();
});

test("quick add creates a task from the title alone and ignores blank input", async ({ page }) => {
  await page.goto("/tasks");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") {
      posts.push(request.postData() ?? "");
    }
  });
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("   ");
  await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
  await field.press("Enter");

  await field.fill("Water the plants");
  await field.press("Enter");
  await expect(page.getByText("Water the plants")).toBeVisible();
  await expect(field).toHaveValue("");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0] ?? "{}")).toMatchObject({ title: "Water the plants" });
});

test("quick add files a new task in the focused list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks");
  await page
    .getByRole("navigation", { name: "Lists" })
    .getByRole("button", { name: "Errands, 1 task" })
    .click();
  const request = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/tasks"
  );
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("Post the parcel");
  await field.press("Enter");
  expect((await request).postDataJSON()).toMatchObject({
    title: "Post the parcel",
    listId: "list-2"
  });
  await expect(page.getByText("Post the parcel")).toBeVisible();
});

test("quick add sends one request while saving and keeps the draft when it fails", async ({
  page
}) => {
  let posts = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    await held;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Server unavailable" })
    });
  });
  await page.goto("/tasks");
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("Call the plumber");
  await field.press("Enter");
  await field.press("Enter");
  await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
  release();

  await expect(page.getByRole("alert")).toContainText("Could not add the task.");
  await expect(field).toHaveValue("Call the plumber");
  expect(posts).toBe(1);
});

test("quick add admits one same-turn submission and allows a deliberate retry after failure", async ({
  page
}) => {
  let posts = 0;
  let failing = true;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") {
      posts += 1;
    }
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST" || !failing) return route.fallback();
    await held;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Server unavailable" })
    });
  });
  await page.goto("/tasks");
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("Call the plumber");
  // Native form submissions in one turn expose admission before the pending render.
  await page.getByRole("form", { name: "Capture a task" }).evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("Could not add the task.");
  await expect(field).toHaveValue("Call the plumber");
  expect(posts).toBe(1);

  failing = false;
  await field.press("Enter");
  await expect(page.getByText("Call the plumber")).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(posts).toBe(2);
});

test("quick add keeps text typed during a successful save", async ({ page }) => {
  let posts = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    await held;
    return route.fallback();
  });
  await page.goto("/tasks");
  const field = page.getByRole("textbox", { name: "Task title" });
  await field.fill("Call the plumber");
  await field.press("Enter");
  await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
  await field.fill("Book the electrician");
  await field.press("Enter");
  release();

  await expect(page.getByText("Call the plumber")).toBeVisible();
  await expect(field).toHaveValue("Book the electrician");
  await expect(page.getByRole("button", { name: "Add task" })).toBeEnabled();
  expect(posts).toBe(1);
});

const serverError = { status: 500, contentType: "application/json", body: '{"error":"down"}' };

test("a failed task load says so and Retry recovers", async ({ page }) => {
  let failing = true;
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "GET" && failing ? route.fulfill(serverError) : route.fallback()
  );
  await page.goto("/tasks");
  await expect(page.getByRole("alert")).toContainText("Could not load your tasks");
  await expect(page.getByText("No tasks yet")).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("File taxes")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed background refresh keeps the loaded tasks and says so", async ({ page }) => {
  let gets = 0;
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    gets += 1;
    return gets === 1 ? route.fallback() : route.fulfill(serverError);
  });
  await page.goto("/tasks");
  const box = page.getByRole("checkbox", { name: "Complete File taxes" });
  await page.locator("label.jds-check", { has: box }).click();
  await expect(page.getByRole("alert")).toContainText("Could not refresh your tasks");
  await expect(page.getByText("Learn cello")).toBeVisible();
});

test("a literal search with no match offers Clear filters", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Toggle search" }).click();
  await page.getByLabel("Search tasks").fill("zebra");
  await expect(page.getByText("No tasks match")).toBeVisible();
  await expect(page.getByText("No tasks yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("File taxes")).toBeVisible();
  await expect(page.getByLabel("Search tasks")).toHaveValue("");
});

test("a failed completion puts the checkbox back and says so", async ({ page }) => {
  await page.route("**/api/tasks/*", (route) =>
    route.request().method() === "PATCH" ? route.fulfill(serverError) : route.fallback()
  );
  await page.goto("/tasks");
  const box = page.getByRole("checkbox", { name: "Complete File taxes" });
  await page.locator("label.jds-check", { has: box }).click();
  await expect(page.getByRole("alert")).toContainText("Could not update the task");
  await expect(box).not.toBeChecked();
});

test("a failed view save keeps the previous view and says so", async ({ page }) => {
  await page.route("**/api/tasks/preferences", (route) =>
    route.request().method() === "GET" ? route.fallback() : route.fulfill(serverError)
  );
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save the view");
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText("Critical")).toBeVisible();
});

test("a failed saved-view load shows List with a Retry", async ({ page }) => {
  await page.route("**/api/tasks/preferences", (route) =>
    route.request().method() === "GET" ? route.fulfill(serverError) : route.fallback()
  );
  await page.goto("/tasks");
  await expect(page.getByText("Could not load your saved view, so List is showing.")).toBeVisible();
  await expect(page.getByText("File taxes")).toBeVisible();
});

test("failed lists show Retry in the index without inventing a list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let failing = true;
  await page.route("**/api/tasks/lists", (route) =>
    route.request().method() === "GET" && failing ? route.fulfill(serverError) : route.fallback()
  );
  await page.goto("/tasks");
  const index = page.getByRole("navigation", { name: "Lists" });
  await expect(index.getByText("Lists could not load.")).toBeVisible();
  await expect(index.getByRole("button", { name: /Personal/ })).toHaveCount(0);
  failing = false;
  await index.getByRole("button", { name: "Retry" }).click();
  await expect(index.getByRole("button", { name: /Personal/ })).toBeVisible();
});
