import { expect, test, type Locator, type Page } from "@playwright/test";

import { restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "solo-admin",
  without: [],
  chatScript: "3125-main-chat"
} as const;

const MAIN_MESSAGE = "UAT-3125 Main transcript marker";
const SIDE_MESSAGE = "UAT-3125 side transcript marker";

// This fixture-backed scenario is deterministic automated regression coverage. It does not
// establish the live-path proof, which must exercise the configured real model separately.

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return projectName;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function send(drawer: Locator, message: string): Promise<void> {
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  await expect(drawer.getByText(message, { exact: true })).toBeVisible();
  await expect(drawer.getByText("UAT-3125 scripted reply.", { exact: true }).last()).toBeVisible();
}

async function openHistory(drawer: Locator): Promise<void> {
  await drawer.getByRole("button", { name: "More chat options" }).click();
  await drawer.getByRole("menuitemcheckbox", { name: "Show chat history" }).click();
  await expect(drawer.getByText("History", { exact: true })).toBeVisible();
}

async function threadIdFor(page: Page, marker: string): Promise<{ id: string; isMain: boolean }> {
  const threadsResponse = await page.request.get(
    `${requireBaseURL()}/api/chat/threads?surface=drawer`
  );
  expect(threadsResponse.ok()).toBeTruthy();
  const body = (await threadsResponse.json()) as {
    threads: readonly { id: string; isMain: boolean }[];
  };
  for (const thread of body.threads) {
    const messagesResponse = await page.request.get(
      `${requireBaseURL()}/api/chat/threads/${thread.id}/messages?surface=drawer`
    );
    expect(messagesResponse.ok()).toBeTruthy();
    const messages = (await messagesResponse.json()) as {
      messages: readonly { body: string }[];
    };
    if (messages.messages.some((message) => message.body === marker)) return thread;
  }
  throw new Error(`no stored drawer thread contains ${marker}`);
}

test("cold drawer reconnect returns to Main while side history remains separate (#3125)", async ({
  page
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  let drawer = await openChat(page);
  let mainThreadId = "";
  let sideThreadId = "";

  await test.step("create a Main transcript, then create a later side transcript", async () => {
    await send(drawer, MAIN_MESSAGE);
    const main = await threadIdFor(page, MAIN_MESSAGE);
    expect(main.isMain).toBe(true);
    mainThreadId = main.id;
    await drawer.getByRole("button", { name: "New chat" }).click();
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toHaveCount(0);
    await send(drawer, SIDE_MESSAGE);
    const side = await threadIdFor(page, SIDE_MESSAGE);
    expect(side.isMain).toBe(false);
    sideThreadId = side.id;
    expect(sideThreadId).not.toBe(mainThreadId);
  });

  await test.step("a browser reload rebinds a warm side engine to the same Main thread", async () => {
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(SIDE_MESSAGE, { exact: true })).toHaveCount(0);
    await expect(threadIdFor(page, MAIN_MESSAGE)).resolves.toEqual({
      id: mainThreadId,
      isMain: true
    });
  });

  await test.step("history selection still opens each preserved transcript", async () => {
    await openHistory(drawer);
    const mainHistoryRow = drawer.getByRole("button", { name: new RegExp(MAIN_MESSAGE) });
    const sideHistoryRow = drawer.getByRole("button", { name: new RegExp(SIDE_MESSAGE) });
    await expect(mainHistoryRow).toBeVisible();
    await expect(sideHistoryRow).toBeVisible();
    await mainHistoryRow.click();
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(SIDE_MESSAGE, { exact: true })).toHaveCount(0);
    await openHistory(drawer);
    await sideHistoryRow.click();
    await expect(drawer.getByText(SIDE_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toHaveCount(0);
  });

  await test.step("a real server restart and browser reload cold-launches Main", async () => {
    await restartUatStack(requireProjectName(), requireBaseURL());
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(SIDE_MESSAGE, { exact: true })).toHaveCount(0);
    await expect(threadIdFor(page, MAIN_MESSAGE)).resolves.toEqual({
      id: mainThreadId,
      isMain: true
    });
  });

  await test.step("the later side transcript remains available after reconnect", async () => {
    await openHistory(drawer);
    const sideHistoryRow = drawer.getByRole("button", { name: new RegExp(SIDE_MESSAGE) });
    await expect(sideHistoryRow).toBeVisible();
    await sideHistoryRow.click();
    await expect(drawer.getByText(SIDE_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(MAIN_MESSAGE, { exact: true })).toHaveCount(0);
  });
});
