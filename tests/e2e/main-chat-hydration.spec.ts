import { expect, test } from "@playwright/test";

import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

test("drawer hydrates the owner's Main before a newer shared foreign Main (#3125, #3192)", async ({
  page
}) => {
  const ownMain = createMockChatThread("own-main", "My Main", { isMain: true });
  const foreignMain = createMockChatThread("foreign-main", "Shared Main", {
    ownerUserId: "user-2",
    isMain: true,
    lastActiveAt: "2026-10-08T12:00:00.000Z"
  });
  await mockApi(page, {
    authenticated: true,
    chatThreads: [foreignMain, ownMain],
    chatMessages: {
      "own-main": [createMockChatMessage("own-history", "own-main", "My preserved history")],
      "foreign-main": [
        createMockChatMessage("shared-history", "foreign-main", "Legitimately shared history")
      ]
    },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  let resumedThread = "";
  let finishResume!: () => void;
  const resumeFinished = new Promise<void>((resolve) => {
    finishResume = resolve;
  });
  await page.route(/\/api\/chat\/threads\/[^/]+\/resume/, async (route) => {
    resumedThread = route.request().url().includes("/own-main/") ? "own-main" : "foreign-main";
    await resumeFinished;
    await route.fulfill({ status: resumedThread === "own-main" ? 204 : 404, body: "" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect.poll(() => resumedThread).toBe("own-main");
  await expect(drawer.getByLabel("Message Moss")).toBeDisabled();
  finishResume();
  await expect(drawer.getByText("My preserved history", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Legitimately shared history", { exact: true })).toHaveCount(0);
  expect(resumedThread).toBe("own-main");

  // The ordinary reply must use the same owner-selected binding as the displayed history.
  await page.route("**/api/chat/turn", async (route) => {
    expect(resumedThread).toBe("own-main");
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const turn = page.waitForResponse((response) => response.url().endsWith("/api/chat/turn"));
  await drawer.getByLabel("Message Moss").fill("Continue my Main");
  await drawer.getByLabel("Message Moss").press("Enter");
  expect((await turn).ok()).toBe(true);
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  const conversations = drawer.getByLabel("Conversations", { exact: true });
  await expect(
    conversations.getByRole("button", { name: "Main chat", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    conversations.getByRole("button", { name: "Shared Main", exact: true })
  ).toHaveAttribute("aria-pressed", "false");
});
