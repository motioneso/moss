// tests/uat/specs/3410-api-key-chat.uat.spec.ts
//
// #3410 live path: with an API-key provider as the instance default, the chat drawer answers,
// asks for confirmation before a write, and the approved task exists. Opt-in: runs only when the
// four MOSS_UAT_CHAT_PROVIDER_* host variables are set and a relay answers on the bridge gateway.
import { expect, test, type Locator } from "@playwright/test";

import { apiKeyChatUatConfigured } from "../api-key-chat-env.js";
import { readUatJson, requireUatBaseURL, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withApiKeyChatProvider: true
} as const;

const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const TASK_TITLE = "Ada's API-key chat task";

test("an API-key provider drives drawer chat through a confirmation card (#3410)", async ({
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

  await test.step("ask for a task and approve the confirmation card", async () => {
    const composer = drawer.getByLabel("Message Moss");
    await composer.fill(`Add a task called "${TASK_TITLE}".`);
    const turnResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
        response.request().method() === "POST",
      { timeout: 300_000 }
    );
    await composer.press("Enter");

    const card = page.locator(ACTION_CARD).last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 180_000 });
    await card.getByRole("button", { name: "Approve" }).click();

    const response = await turnResponse;
    expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
  });

  await test.step("the approved task exists", async () => {
    await expect
      .poll(
        async () => {
          const body = (await readUatJson(
            await page.request.get(`${requireUatBaseURL()}/api/tasks`)
          )) as { tasks: Array<{ title: string }> };
          return body.tasks.some((task) => task.title === TASK_TITLE);
        },
        { timeout: 30_000, message: "the approved task never appeared" }
      )
      .toBe(true);
  });
});
