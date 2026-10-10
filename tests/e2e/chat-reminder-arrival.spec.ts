import { expect, test, type Page, type Route } from "@playwright/test";

import type { ChatMessageDto } from "@moss/shared";

import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

// #3195: a delivered reminder appears at once in the open Main chat beside a streaming reply,
// each keeps its own identity through reconnect and reload, a side chat never shows it, and Main
// shows it again once a private chat ends.

const reminderRecord = {
  kind: "reply",
  text: "Reminder: stretch",
  messageId: "reminder-1",
  background: true
};

function sse(...records: readonly object[]): string {
  return records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");
}

function fulfillStream(route: Route, body: string): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache" },
    body
  });
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function mockChat(
  page: Page,
  threads: ReturnType<typeof createMockChatThread>[],
  chatMessages: Record<string, ChatMessageDto[]>,
  incognito = false
): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    incognito,
    chatThreads: threads,
    chatMessages,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.route(/\/api\/chat\/threads\/[^/]+\/resume/, (route) =>
    route.fulfill({ status: 204, body: "" })
  );
}

test("a reminder arrives beside a streaming Main reply and stays single after reconnect and reload", async ({
  page
}) => {
  const main = createMockChatThread("own-main", "Main chat", { isMain: true });
  const history: ChatMessageDto[] = [createMockChatMessage("earlier", main.id, "Earlier talk")];
  await mockChat(page, [main], { [main.id]: history });

  const first = gate();
  const second = gate();
  let connections = 0;
  await page.route("**/api/chat/stream*", async (route) => {
    connections += 1;
    if (connections === 1) {
      await first.promise;
      return fulfillStream(
        route,
        sse(
          { kind: "user", text: "Plan my lunch" },
          { kind: "reply", text: "Thinking about lunch", turnId: "turn-1" },
          reminderRecord
        )
      );
    }
    if (connections === 2) {
      await second.promise;
      return fulfillStream(
        route,
        sse(
          { kind: "reply", text: "Soup and bread", turnId: "turn-1", messageId: "reply-1" },
          reminderRecord
        )
      );
    }
    // Hold later reconnects open so nothing replays.
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer.getByText("Earlier talk", { exact: true })).toBeVisible();

  first.release();
  await expect(drawer.getByText("Thinking about lunch", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(1);

  // The reconnect reads Main's history and replays both records. Neither appears twice, and the
  // stored reply replaces only its own unsaved version.
  history.push(
    createMockChatMessage("user-1", main.id, "Plan my lunch"),
    createMockChatMessage("reply-1", main.id, "Soup and bread", { role: "assistant" }),
    createMockChatMessage("reminder-1", main.id, "Reminder: stretch", {
      role: "assistant",
      origin: { version: 1, kind: "reminder", event: "delivered", reminderId: "saved-1" }
    })
  );
  second.release();
  await expect(drawer.getByText("Soup and bread", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Thinking about lunch", { exact: true })).toHaveCount(0);
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(1);

  await page.reload();
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(drawer.getByText("Earlier talk", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Soup and bread", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Plan my lunch", { exact: true })).toHaveCount(1);
});

test("a new side chat never shows a reminder and keeps its draft and focus", async ({ page }) => {
  const main = createMockChatThread("own-main", "Main chat", { isMain: true });
  const side = createMockChatThread("side-chat", "New chat", {
    lastActiveAt: "2026-06-05T12:00:00.000Z"
  });
  await mockChat(page, [main, side], {
    [main.id]: [createMockChatMessage("earlier", main.id, "Earlier talk")],
    [side.id]: []
  });
  let sideStarted = false;
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/clear"),
    async (route) => {
      sideStarted = true;
      await route.fulfill({ status: 204, body: "" });
    }
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/privacy"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          incognito: false,
          ...(sideStarted ? { threadId: "side-chat" } : {})
        })
      })
  );

  const arrival = gate();
  await page.route("**/api/chat/stream*", async (route) => {
    await arrival.promise;
    await fulfillStream(
      route,
      sse({ kind: "user", text: "Where next?" }, reminderRecord, {
        kind: "reply",
        text: "Try the coast",
        turnId: "turn-side"
      })
    ).catch(() => undefined);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer.getByText("Earlier talk", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat" }).click();
  await expect(drawer.getByText("Earlier talk", { exact: true })).toHaveCount(0);

  const composer = drawer.getByLabel("Message Moss");
  await expect(composer).toBeEditable();
  await composer.click();
  await composer.pressSequentially("Book the train for");

  arrival.release();
  await expect(drawer.getByText("Try the coast", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Book the train for");
  await expect(composer).toBeFocused();
});

test("Main shows a reminder that arrives after a private chat ends", async ({ page }) => {
  const main = createMockChatThread("own-main", "Main chat", { isMain: true });
  await mockChat(page, [main], { [main.id]: [] }, true);
  let privateEnded = false;
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/private/end"),
    async (route) => {
      privateEnded = true;
      await route.fulfill({ status: 204, body: "" });
    }
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/privacy"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          privateEnded ? { incognito: false, threadId: main.id } : { incognito: true }
        )
      })
  );

  // Hold every stream open until the private chat has ended, then deliver the reminder.
  const arrival = gate();
  await page.route("**/api/chat/stream*", async (route) => {
    await arrival.promise;
    await fulfillStream(route, sse(reminderRecord)).catch(() => undefined);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const privateBanner = drawer.locator(".chatd-private").filter({ hasText: "not saved" });
  await expect(privateBanner).toBeVisible();
  await privateBanner.getByRole("button", { name: "End" }).click();
  await expect(privateBanner).toHaveCount(0);
  await expect.poll(() => privateEnded).toBe(true);

  arrival.release();
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(1);
});

test("Main picked again from the conversation list shows a reminder at once", async ({ page }) => {
  const main = createMockChatThread("own-main", "Main chat", { isMain: true });
  const side = createMockChatThread("side-chat", "New chat", {
    lastActiveAt: "2026-06-05T12:00:00.000Z"
  });
  await mockChat(page, [main, side], {
    [main.id]: [createMockChatMessage("earlier", main.id, "Earlier talk")],
    [side.id]: []
  });
  let shownThread: string | undefined;
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/clear"),
    async (route) => {
      shownThread = side.id;
      await route.fulfill({ status: 204, body: "" });
    }
  );
  await page.route(/\/api\/chat\/threads\/[^/]+\/resume/, async (route) => {
    shownThread = /threads\/([^/]+)\/resume/.exec(route.request().url())?.[1];
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/privacy"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          incognito: false,
          ...(shownThread ? { threadId: shownThread } : {})
        })
      })
  );

  // Hold every stream open until Main is back on screen, then deliver the reminder.
  const arrival = gate();
  await page.route("**/api/chat/stream*", async (route) => {
    await arrival.promise;
    await fulfillStream(route, sse(reminderRecord)).catch(() => undefined);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer.getByText("Earlier talk", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat" }).click();
  await expect(drawer.getByText("Earlier talk", { exact: true })).toHaveCount(0);

  await drawer.getByRole("button", { name: "Open conversations" }).click();
  const conversations = drawer.getByLabel("Conversations", { exact: true });
  await conversations.getByRole("button", { name: "Main chat", exact: true }).click();
  await expect(drawer.getByText("Earlier talk", { exact: true })).toBeVisible();
  await expect.poll(() => shownThread).toBe(main.id);

  arrival.release();
  await expect(drawer.getByText("Reminder: stretch", { exact: true })).toHaveCount(1);
});
