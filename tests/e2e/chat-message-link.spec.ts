import { expect, test, type Page } from "@playwright/test";

import type { ChatMessageDto } from "@moss/shared";

import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders, createMockNotification } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

// #3481: a reminder's bell entry and device alert open the exact message in the chat it was
// posted to. A missing or foreign message says so and never falls back to Today.

const main = createMockChatThread("own-main", "Main chat", { isMain: true });
const side = createMockChatThread("side-chat", "Travel", {
  lastActiveAt: "2026-06-05T12:00:00.000Z"
});

function longChat(threadId: string, reminderId: string, text: string): ChatMessageDto[] {
  const filler = (index: number) =>
    createMockChatMessage(`${threadId}-${index}`, threadId, `Earlier line ${index} `.repeat(12), {
      role: index % 2 === 0 ? "user" : "assistant"
    });
  return [
    ...Array.from({ length: 12 }, (_, index) => filler(index)),
    createMockChatMessage(reminderId, threadId, text, {
      role: "assistant",
      origin: { version: 1, kind: "reminder", event: "delivered", reminderId: "saved-1" }
    }),
    ...Array.from({ length: 12 }, (_, index) => filler(index + 12))
  ];
}

async function mockLinks(
  page: Page,
  locations: Record<string, { threadId: string; messageId: string }>
): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [main, side],
    chatMessages: {
      [main.id]: longChat(main.id, "reminder-main", "Reminder: stretch"),
      [side.id]: longChat(side.id, "reminder-side", "Reminder: book the train")
    },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [
      createMockNotification("n-side", "Reminder from Moss", {
        moduleId: "chat",
        body: "Reminder: book the train",
        href: "/chat/messages/reminder-side",
        metadata: { kind: "chat_reminder", reminderId: "saved-1", messageId: "reminder-side" }
      })
    ],
    tasks: []
  });
  await page.route(/\/api\/chat\/threads\/[^/]+\/resume/, (route) =>
    route.fulfill({ status: 204, body: "" })
  );
  await page.route(/\/api\/chat\/messages\/[^/]+\/location$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4] ?? "");
    const location = locations[id];
    return location
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(location)
        })
      : route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Chat message not found" })
        });
  });
}

test("the bell's View opens a side chat focused on its reminder", async ({ page }) => {
  await mockLinks(page, { "reminder-side": { threadId: side.id, messageId: "reminder-side" } });
  await page.goto("/notifications");
  await page.getByRole("link", { name: "View" }).click();

  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const linked = drawer.locator("[data-linked-message]");
  await expect(linked).toContainText("Reminder: book the train");
  await expect(linked).toBeFocused();
  await expect(linked).toBeInViewport();
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/notifications$/);
});

test("the same reminder link focuses its message again after the chat closes", async ({ page }) => {
  await mockLinks(page, { "reminder-side": { threadId: side.id, messageId: "reminder-side" } });
  await page.goto("/notifications");
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const linked = drawer.locator("[data-linked-message]");

  await page.getByRole("link", { name: "View" }).click();
  await expect(linked).toBeFocused();
  await drawer.getByRole("button", { name: "Close chat" }).click();
  await expect(drawer).toHaveCount(0);

  await page.getByRole("link", { name: "View" }).click();
  await expect(linked).toContainText("Reminder: book the train");
  await expect(linked).toBeFocused();
  await expect(linked).toBeInViewport();
});

test("a device alert link opens Main focused on its reminder", async ({ page }) => {
  await mockLinks(page, { "reminder-main": { threadId: main.id, messageId: "reminder-main" } });
  await page.goto("/chat/messages/reminder-main");

  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const linked = drawer.locator("[data-linked-message]");
  await expect(linked).toContainText("Reminder: stretch");
  await expect(linked).toBeFocused();
  await expect(linked).toBeInViewport();
  await expect(page).toHaveURL(/\/notifications$/);
});

for (const [name, id] of [
  ["another account's message", "someone-elses-reminder"],
  ["a deleted message", "deleted-reminder"]
] as const) {
  test(`${name} says it is not available and never opens Today`, async ({ page }) => {
    await mockLinks(page, {});
    await page.goto(`/chat/messages/${id}`);

    await expect(page.getByText("This message is not available")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/chat/messages/${id}$`));
    await expect(page.getByRole("heading", { name: "Today" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Chat with Moss" })).toHaveCount(0);
    await expect(page.getByText(/Reminder:/)).toHaveCount(0);
  });
}
