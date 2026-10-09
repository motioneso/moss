import { expect, test, type Page } from "@playwright/test";

import { bringUpRealChatModel, readUatJson, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("saved Main draft remains editable through a real provider disable and restore (#3191)", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  const providers = (await readUatJson(await page.request.get("/api/ai/providers"))) as {
    providers: readonly { id: string; status: string }[];
  };
  const active = providers.providers.filter((provider) => provider.status === "active");
  expect(active.length).toBeGreaterThan(0);

  let drawer = await openChat(page);
  const original = "UAT 3191 saved unsent Main draft. Reply briefly when I send this.";
  const edited = "UAT 3191 recovered Main draft. Reply briefly: draft recovered.";
  await drawer.getByLabel("Message Moss").fill(original);
  const threads = (await readUatJson(
    await page.request.get("/api/chat/threads?surface=drawer")
  )) as {
    threads: readonly { id: string; isMain: boolean }[];
  };
  const main = threads.threads.find((thread) => thread.isMain);
  expect(main).toBeDefined();

  try {
    for (const provider of active) {
      await readUatJson(
        await page.request.patch(`/api/ai/providers/${provider.id}`, {
          data: { status: "disabled" }
        })
      );
    }
    const unavailable = (await readUatJson(
      await page.request.get("/api/ai/capability-route/chat")
    )) as { route: { available: boolean } };
    expect(unavailable.route.available).toBe(false);
    // A reload reads persisted configuration and the actual saved draft, without response rewriting.
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText("Not connected", { exact: true })).toBeVisible();
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(original);
    await expect(drawer.getByLabel("Message Moss")).toBeEnabled();
    await drawer.getByLabel("Message Moss").fill(edited);
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(edited);
    console.log(
      "[3191 assertion] persisted provider disable retained an editable saved Main draft and its edit after reload"
    );
  } finally {
    for (const provider of active) {
      await readUatJson(
        await page.request.patch(`/api/ai/providers/${provider.id}`, {
          data: { status: "active" }
        })
      );
    }
  }

  await page.reload();
  drawer = await openChat(page);
  await expect(drawer.getByLabel("Message Moss")).toHaveValue(edited);
  const completed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").press("Enter");
  const response = await completed;
  const result = (await readUatJson(response)) as { reply: string };
  expect(result.reply.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(result.reply, { exact: true }).last()).toBeVisible();
  const history = (await readUatJson(
    await page.request.get(`/api/chat/threads/${main!.id}/messages?surface=drawer`)
  )) as { messages: readonly { body: string }[] };
  expect(history.messages.filter((message) => message.body === edited)).toHaveLength(1);
  expect(history.messages.some((message) => message.body === original)).toBe(false);
  console.log(
    "[3191 assertion] restored configured economy provider completed the edited draft once in its original Main"
  );
});
