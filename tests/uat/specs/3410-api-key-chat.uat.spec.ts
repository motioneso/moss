// tests/uat/specs/3410-api-key-chat.uat.spec.ts
//
// #3410 live path: with an API-key provider as the instance default, the chat drawer runs an
// ordinary write (add a task) without asking and asks before a destructive one (delete a list).
// Opt-in: runs only when the four MOSS_UAT_CHAT_PROVIDER_* host variables are set and a relay
// answers on the bridge gateway.
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

import { apiKeyChatUatConfigured } from "../api-key-chat-env.js";
import { readUatJson, requireUatBaseURL, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withApiKeyChatProvider: true
} as const;

const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const TASK_TITLE = "Ada's API-key chat task";
const LIST_NAME = "Ada's API-key chat list";

test("an API-key provider drives drawer chat, asking only before a destructive action (#3410)", async ({
  page
}) => {
  test.skip(
    !apiKeyChatUatConfigured(process.env),
    "Set the four MOSS_UAT_CHAT_PROVIDER_* variables to run this proof"
  );
  test.setTimeout(420_000);

  const drawer: Locator = page.locator("aside.chatd");

  await test.step("sign in and open the drawer", async () => {
    await signInUatAdmin(page);
    await page.locator(".topbar-actions button").click();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
  });

  await test.step("an ordinary write runs without a confirmation card", async () => {
    await sendAndAwaitTurn(drawer, page, `Add a task called "${TASK_TITLE}".`);
    await expect(page.locator(ACTION_CARD)).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const body = (await readUatJson(
            await page.request.get(`${requireUatBaseURL()}/api/tasks`)
          )) as { tasks: Array<{ title: string }> };
          return body.tasks.some((task) => task.title === TASK_TITLE);
        },
        { timeout: 30_000, message: "the task never appeared" }
      )
      .toBe(true);
  });

  await test.step("a destructive action asks first, and the approved delete happens", async () => {
    const created = await page.request.post(`${requireUatBaseURL()}/api/tasks/lists`, {
      data: { name: LIST_NAME }
    });
    expect(created.ok(), `create list -> ${created.status()}`).toBe(true);
    const { list } = (await readUatJson(created)) as { list: { id: string } };

    const turnResponse = sendTurn(drawer, page, `Delete my task list called "${LIST_NAME}".`);
    const card = page.locator(ACTION_CARD).last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 180_000 });
    await card.getByRole("button", { name: "Approve" }).click();

    const response = await turnResponse;
    expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
    await expect
      .poll(
        async () => {
          const body = (await readUatJson(
            await page.request.get(`${requireUatBaseURL()}/api/tasks/lists`)
          )) as { lists: Array<{ id: string }> };
          return body.lists.some((entry) => entry.id === list.id);
        },
        { timeout: 30_000, message: "the approved delete never removed the list" }
      )
      .toBe(false);
  });
});

// Registers the turn waiter before sending. The turn response arrives only after any approval,
// so a caller that must approve awaits the returned promise after clicking.
async function sendTurn(drawer: Locator, page: Page, text: string): Promise<Response> {
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(text);
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 300_000 }
  );
  await composer.press("Enter");
  return turnResponse;
}

async function sendAndAwaitTurn(drawer: Locator, page: Page, text: string): Promise<void> {
  const response = await sendTurn(drawer, page, text);
  expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
}
