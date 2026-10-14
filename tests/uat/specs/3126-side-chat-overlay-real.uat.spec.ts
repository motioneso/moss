import { expect, test, type Locator, type Page } from "@playwright/test";

import { bringUpRealChatModel, readUatJson, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

const MAIN = "UAT 3126 main conversation. Reply briefly: main saved.";
const SIDE = "UAT 3126 side conversation. Reply briefly: side saved.";

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendReal(page: Page, drawer: Locator, text: string): Promise<void> {
  const completed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").fill(text);
  await drawer.getByLabel("Message Moss").press("Enter");
  const response = await completed;
  expect(response.ok(), `real UI turn returned ${response.status()}`).toBe(true);
  const result = (await response.json()) as { reply?: string };
  expect(result.reply?.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(text, { exact: true })).toBeVisible();
  await expect(drawer.getByText(result.reply!, { exact: true }).last()).toBeVisible();
  console.log(`[3126 real reply] ${JSON.stringify(result.reply!.slice(0, 300))}`);
}

async function conversations(page: Page, drawer: Locator): Promise<void> {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await expect(drawer.getByLabel("Conversations", { exact: true })).toBeVisible();
}

async function threadsWithHistory(page: Page): Promise<
  readonly {
    id: string;
    title: string;
    isMain: boolean;
    messages: readonly { body: string }[];
  }[]
> {
  const body = (await readUatJson(await page.request.get("/api/chat/threads?surface=drawer"))) as {
    threads: readonly { id: string; title: string; isMain: boolean }[];
  };
  return Promise.all(
    body.threads.map(async (thread) => {
      const history = (await readUatJson(
        await page.request.get(`/api/chat/threads/${thread.id}/messages?surface=drawer`)
      )) as { messages: readonly { body: string }[] };
      return { ...thread, messages: history.messages };
    })
  );
}

test("real model keeps Main and side-chat transcripts distinct through Conversations (#3126)", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "real configured login is required").toBe(
    "1"
  );
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.log(
    `[3126 real model] active=${model.status} tier=${model.tier} configuredId=${model.id}`
  );

  const drawer = await openChat(page);
  await expect(drawer.getByRole("button", { name: "New side chat" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Open conversations" })).toHaveAttribute(
    "aria-expanded",
    "false"
  );

  await sendReal(page, drawer, MAIN);
  const main = (await threadsWithHistory(page)).find((thread) =>
    thread.messages.some((message) => message.body === MAIN)
  );
  expect(main?.isMain).toBe(true);

  await conversations(page, drawer);
  await drawer.getByRole("button", { name: "New side chat" }).click();
  await expect(drawer.getByLabel("Message Moss")).toBeFocused();
  await sendReal(page, drawer, SIDE);

  const side = (await threadsWithHistory(page)).find((thread) =>
    thread.messages.some((message) => message.body === SIDE)
  );
  expect(side?.isMain).toBe(false);
  expect(side?.id).not.toBe(main?.id);
  expect(side?.messages.some((message) => message.body === MAIN)).toBe(false);
  expect(side?.title).toBe("UAT 3126 side conversation");

  await conversations(page, drawer);
  await drawer.getByRole("button", { name: "Main chat" }).click();
  await expect(drawer.getByText(MAIN, { exact: true })).toBeVisible();
  await expect(drawer.getByText(SIDE, { exact: true })).toHaveCount(0);

  await drawer.getByLabel("Message Moss").fill("Main unsent draft");
  await conversations(page, drawer);
  await drawer.getByRole("button", { name: side!.title }).click();
  await drawer.getByLabel("Message Moss").fill("Side unsent draft");
  await conversations(page, drawer);
  await drawer.getByRole("button", { name: "Main chat" }).click();
  await expect(drawer.getByLabel("Message Moss")).toHaveValue("Main unsent draft");

  await page.reload();
  const reloaded = await openChat(page);
  await expect(reloaded.getByLabel("Message Moss")).toHaveValue("Main unsent draft");
  await conversations(page, reloaded);
  await reloaded.getByRole("button", { name: side!.title, exact: true }).click();
  await expect(reloaded.getByLabel("Message Moss")).toHaveValue("Side unsent draft");

  await page.setViewportSize({ width: 390, height: 844 });
  await conversations(page, reloaded);
  await reloaded.getByRole("button", { name: "New side chat" }).click();
  await expect(reloaded.getByLabel("Message Moss")).toBeFocused();
  const phoneSide = (await threadsWithHistory(page)).find(
    (thread) => !thread.isMain && thread.id !== side!.id
  );
  expect(phoneSide).toBeDefined();
  await reloaded.getByLabel("Message Moss").fill("Phone side unsent draft");
  await page.reload();
  const phoneReloaded = await openChat(page);
  await conversations(page, phoneReloaded);
  await phoneReloaded.getByRole("button", { name: phoneSide!.title, exact: true }).click();
  await expect(phoneReloaded.getByLabel("Message Moss")).toHaveValue("Phone side unsent draft");
  await conversations(page, phoneReloaded);
  await phoneReloaded.getByRole("button", { name: "Main chat" }).click();
  await expect(phoneReloaded.getByLabel("Message Moss")).toHaveValue("Main unsent draft");

  console.log(
    `[3126 assertion] Main=${main!.id} and side=${side!.id} stayed separate with drafts after desktop and phone reloads`
  );
});
