import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Response
} from "@playwright/test";

import { restartUatStack } from "../provisioner.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatProjectName,
  requireUatBaseURL,
  signInUatAdmin
} from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

const MAIN = "UAT-3125 Main history. Reply briefly: Main saved.";
const SIDE = "UAT-3125 side history. Reply briefly: Side saved.";
const PRIVATE = "UAT-3125 private history. Reply briefly: Private acknowledged.";

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
  expect(typeof result.reply).toBe("string");
  expect(result.reply?.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(text, { exact: true })).toBeVisible();
  await expect(drawer.getByText(result.reply!, { exact: true }).last()).toBeVisible();
  console.log(`[3125 real reply] ${JSON.stringify(result.reply!.slice(0, 300))}`);
}

async function threadsWithHistory(page: Page): Promise<
  readonly {
    id: string;
    title: string;
    isMain: boolean;
    ownerUserId: string;
    messages: readonly { body: string }[];
  }[]
> {
  const body = (await readUatJson(await page.request.get("/api/chat/threads?surface=drawer"))) as {
    threads: readonly { id: string; title: string; isMain: boolean; ownerUserId: string }[];
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

async function openConversations(drawer: Locator): Promise<void> {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await expect(drawer.getByLabel("Conversations", { exact: true })).toBeVisible();
}

test("real model preserves Main across warm/cold reopen and explicit side/private first turns (#3125)", async ({
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
    `[3125 real model] active=${model.status} tier=${model.tier} configuredId=${model.id}`
  );
  await page.reload();
  let drawer = await openChat(page);
  let mainId = "";
  let sideId = "";

  await test.step("Main and later side first turns persist into separate threads", async () => {
    await sendReal(page, drawer, MAIN);
    const main = (await threadsWithHistory(page)).find((thread) =>
      thread.messages.some((message) => message.body === MAIN)
    );
    expect(main?.isMain).toBe(true);
    mainId = main!.id;
    await openConversations(drawer);
    await drawer.getByRole("button", { name: "New side chat" }).click();
    await expect(drawer.getByLabel("Message Moss")).toBeFocused();
    await expect(drawer.getByText(MAIN, { exact: true })).toHaveCount(0);
    await sendReal(page, drawer, SIDE);
    const side = (await threadsWithHistory(page)).find((thread) =>
      thread.messages.some((message) => message.body === SIDE)
    );
    expect(side?.isMain).toBe(false);
    sideId = side!.id;
    expect(sideId).not.toBe(mainId);
    expect(side?.messages.some((message) => message.body === MAIN)).toBe(false);
    console.log("[3125 assertion] Main and later side first turns stored separately");
  });

  await test.step("warm side engine reload hydrates Main and its next real reply", async () => {
    const order: string[] = [];
    const resumed = (response: Response) => {
      if (
        new URL(response.url()).pathname === `/api/chat/threads/${mainId}/resume` &&
        response.ok()
      )
        order.push("resume");
    };
    const submitted = (request: Request) => {
      if (new URL(request.url()).pathname === "/api/chat/turn" && request.method() === "POST")
        order.push("turn");
    };
    page.on("response", resumed);
    page.on("request", submitted);
    await page.reload();
    drawer = await openChat(page);
    const continuation = "UAT-3125 warm Main continuation. Reply briefly: Warm Main.";
    await sendReal(page, drawer, continuation);
    page.off("response", resumed);
    page.off("request", submitted);
    expect(order).toEqual(["resume", "turn"]);
    await expect(drawer.getByText(MAIN, { exact: true })).toBeVisible();
    await expect(drawer.getByText(SIDE, { exact: true })).toHaveCount(0);
    const stored = await threadsWithHistory(page);
    expect(stored.find((thread) => thread.id === mainId)?.messages).toContainEqual(
      expect.objectContaining({ body: continuation })
    );
    expect(stored.find((thread) => thread.id === sideId)?.messages).not.toContainEqual(
      expect.objectContaining({ body: continuation })
    );
    console.log(
      `[3125 assertion] immediate next reply follows public resume and remains on Main=${mainId}; side=${sideId}`
    );
  });

  await test.step("preserved side resumes, then cold server reopen restores original Main", async () => {
    const side = (await threadsWithHistory(page)).find((thread) => thread.id === sideId);
    expect(side?.title).toBeTruthy();
    await openConversations(drawer);
    await drawer.getByRole("button", { name: side!.title, exact: true }).click();
    await expect(drawer.getByText(SIDE, { exact: true })).toBeVisible();
    await expect(drawer.getByText(MAIN, { exact: true })).toHaveCount(0);
    await restartUatStack(requireUatProjectName(), requireUatBaseURL());
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText(MAIN, { exact: true })).toBeVisible();
    await expect(drawer.getByText(SIDE, { exact: true })).toHaveCount(0);
    const continuation = "UAT-3125 cold Main continuation. Reply briefly: Cold Main.";
    await sendReal(page, drawer, continuation);
    expect(
      (await threadsWithHistory(page)).find((thread) => thread.id === mainId)?.messages
    ).toContainEqual(expect.objectContaining({ body: continuation }));
    console.log(
      "[3125 assertion] cold server restart preserves Main identity/history and next reply"
    );
  });

  await test.step("explicit private first turn stays private and does not append to Main or side", async () => {
    await drawer.getByRole("button", { name: "More chat options" }).click();
    await drawer.getByRole("menuitemcheckbox", { name: "Start private chat" }).click();
    await expect(
      drawer.getByText("Private chat: not saved to history. Approved actions still keep records.", {
        exact: true
      })
    ).toBeVisible();
    const privacy = (await readUatJson(await page.request.get("/api/chat/privacy"))) as {
      incognito: boolean;
    };
    expect(privacy.incognito).toBe(true);
    await expect(drawer.getByText(MAIN, { exact: true })).toHaveCount(0);
    await sendReal(page, drawer, PRIVATE);
    expect(
      (await threadsWithHistory(page)).every((thread) =>
        thread.messages.every((message) => message.body !== PRIVATE)
      )
    ).toBe(true);
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText(MAIN, { exact: true })).toBeVisible();
    await expect(drawer.getByText(PRIVATE, { exact: true })).toHaveCount(0);
    expect((await threadsWithHistory(page)).find((thread) => thread.id === mainId)?.isMain).toBe(
      true
    );
    console.log(
      "[3125 assertion] private first real reply stays ephemeral; reload restores original Main"
    );
  });
});
