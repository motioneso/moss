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

test("assigning a tag from the task modal renders a chip", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Open File taxes" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Suggestion chips appear for tags not yet assigned; clicking one assigns the tag.
  await page.getByRole("button", { name: "#urgent" }).click();
  // The assigned tag renders as a removable chip.
  await expect(page.getByRole("button", { name: "Remove urgent" })).toBeVisible();
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
