import { expect, test } from "@playwright/test";

import { createMockConnectorProviders } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

test("skills settings leads with the list and opens focused authoring flows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  await page.route("**/api/chat/skills", (route) =>
    route.fulfill({
      json: {
        skills: [
          {
            id: "skill-1",
            ownerUserId: "user-1",
            name: "Daily standup",
            description: "Summarize yesterday and today",
            frontmatter: {},
            body: "Ask for yesterday, today, and blockers.",
            enabled: true,
            source: "authored",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      }
    })
  );

  await page.goto("/settings?section=skills");
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(page.locator(".set-row__desc").filter({ hasText: "/daily-standup" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create skill" })).toBeVisible();
  await expect(page.getByText("Skill instructions", { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByText("Name *", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Skill name (required)" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Skill instructions (required)" })).toBeVisible();
  await expect(page.getByText("Applied only to this invoked turn", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".set-row__desc").filter({ hasText: "/daily-standup" })).toBeVisible();

  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).resolves.toBe(true);
});

test("skill autocomplete hides zero matches and keeps Escape dismissed", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.route("**/api/chat/skills", (route) =>
    route.fulfill({
      json: {
        skills: [
          {
            id: "skill-1",
            ownerUserId: "user-1",
            name: "Daily standup",
            description: "Summarize yesterday and today",
            frontmatter: {},
            body: "Ask for yesterday, today, and blockers.",
            enabled: true,
            source: "authored",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          },
          {
            id: "skill-2",
            ownerUserId: "user-1",
            name: "Weekly review",
            description: null,
            frontmatter: {},
            body: "Review the week.",
            enabled: true,
            source: "authored",
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        ]
      }
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composer = drawer.getByLabel("Message Moss");
  await expect(drawer).toBeVisible();

  await composer.fill("/does-not-exist");
  await expect(drawer.getByRole("listbox", { name: "Skills" })).toHaveCount(0);

  await composer.fill("/");
  const options = drawer.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("Escape");
  await expect(drawer.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
});
