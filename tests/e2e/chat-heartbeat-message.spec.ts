import { expect, test, type Page } from "@playwright/test";

import type { ChatHeartbeatOriginV1, ChatMessageDto } from "@moss/shared";

import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

// Slice 4 of the heartbeat: the check-in message, its rating, and the stop-topic reply.

const origin: ChatHeartbeatOriginV1 = {
  version: 1,
  kind: "heartbeat",
  occurrenceId: "occ-1",
  intro: "Two things need a look.",
  items: [
    {
      findingId: "f-1",
      source: "tasks",
      title: "Send the quarterly timecard",
      at: null,
      note: "It is due today."
    },
    {
      findingId: "f-2",
      source: "sports",
      title: "Harbor FC",
      at: null,
      note: "They play tomorrow at 7:00 AM."
    }
  ]
};

async function openMain(page: Page, history: ChatMessageDto[], afterMock?: () => Promise<void>) {
  const main = createMockChatThread("own-main", "Main chat", { isMain: true });
  await mockApi(page, {
    authenticated: true,
    chatThreads: [main],
    chatMessages: { [main.id]: history },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await afterMock?.();
  await page.route(/\/api\/chat\/threads\/[^/]+\/resume/, (route) =>
    route.fulfill({ status: 204, body: "" })
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  return page.getByRole("dialog", { name: "Chat with Moss" });
}

test("a check-in shows an item card per finding and records a rating that a second click undoes", async ({
  page
}) => {
  const requests: string[] = [];
  const drawer = await openMain(
    page,
    [
      createMockChatMessage("hb-1", "own-main", "Two things need a look.", {
        role: "assistant",
        origin
      })
    ],
    async () => {
      await page.route("**/api/me/usefulness-feedback**", async (route) => {
        requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            feedback: {
              id: "fb-1",
              kind: "more_like_this",
              targetKind: "chat_message",
              status: "active"
            }
          })
        });
      });
    }
  );

  await expect(drawer.getByText("Two things need a look.")).toBeVisible();
  await expect(drawer.getByText("Send the quarterly timecard")).toBeVisible();
  await expect(drawer.getByText("They play tomorrow at 7:00 AM.")).toBeVisible();

  const up = drawer.getByRole("button", { name: "Useful", exact: true });
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "false");
  expect(requests).toEqual([
    "POST /api/me/usefulness-feedback",
    "POST /api/me/usefulness-feedback/fb-1/undo"
  ]);
});

test("a stop-topic result shows Muted with Undo, and Undo removes the mute", async ({ page }) => {
  let deleted = false;
  const drawer = await openMain(page, [], async () => {
    await page.route("**/api/me/heartbeat/mutes/mute-1", async (route) => {
      deleted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true })
      });
    });
    await page.route("**/api/chat/stream*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          kind: "action_result",
          text: "",
          toolName: "chat.heartbeatMute",
          summary: "Stop telling me about timecards",
          decidedBy: "policy",
          actionRequestId: "ar_mute_auto",
          outcome: "executed",
          result: {
            status: "muted",
            mute: {
              id: "mute-1",
              label: "Timecards",
              scope: "topic",
              createdAt: "2026-06-06T12:00:00.000Z"
            }
          }
        })}\n\n`
      })
    );
  });

  await expect(drawer.getByText("Muted", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Timecards", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Undo" }).click();
  await expect(drawer.getByText("Unmuted", { exact: true })).toBeVisible();
  expect(deleted).toBe(true);
});
