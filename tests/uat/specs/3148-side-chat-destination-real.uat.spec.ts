import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  ListScheduledTasksResponse,
  ListChatThreadsResponse,
  ListChatThreadMessagesResponse
} from "@moss/shared";
import { buildUatComposeArgs } from "../provisioner.js";
import { startNewSideChat } from "./notes-new-side-chat.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;

async function tasks(page: Page) {
  return (
    (await readUatJson(
      await page.request.get("/api/chat/scheduled-tasks")
    )) as ListScheduledTasksResponse
  ).tasks;
}
async function threads(page: Page) {
  return (
    (await readUatJson(
      await page.request.get("/api/chat/threads?surface=drawer")
    )) as ListChatThreadsResponse
  ).threads;
}
async function history(page: Page, id: string) {
  return (
    (await readUatJson(
      await page.request.get(`/api/chat/threads/${id}/messages?surface=drawer`)
    )) as ListChatThreadMessagesResponse
  ).messages;
}
async function openChat(page: Page) {
  await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
async function send(page: Page, drawer: Locator, text: string) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").fill(text);
  await drawer.getByLabel("Message Moss").press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(drawer.getByText(text, { exact: true }).last()).toBeVisible();
}
async function select(drawer: Locator, name: string) {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name, exact: true }).click();
  await expect(drawer.getByLabel("Message Moss")).toBeEnabled();
}

test("real task creation, destination edits, isolated delivery and failed target recovery", async ({
  page
}) => {
  test.setTimeout(720_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.log(`[3148] pinned real Codex model=${model.id}, tier=${model.tier}`);
  await page.goto("/settings?section=scheduled");
  let drawer = await openChat(page);
  await send(page, drawer, "Reply briefly: ready for destination proof.");
  const main = (await threads(page)).find((t) => t.isMain)!;
  const sideId = await startNewSideChat(page, drawer);
  await send(page, drawer, "Travel proof. Reply briefly: ready to pack.");
  const side = (await threads(page)).find((t) => t.id === sideId)!;
  expect(side.isMain).toBe(false);
  await send(page, drawer, "remind me in 90 seconds to default route proof");
  const defaultTask = (await tasks(page)).find((t) => t.instruction === "default route proof")!;
  expect(defaultTask.destination).toBeUndefined();
  await send(page, drawer, "remind me in 150 seconds to side route proof, send it to this chat");
  const explicit = (await tasks(page)).find((t) => t.instruction === "side route proof")!;
  expect(explicit.destination).toEqual({ threadId: sideId, title: side.title });
  await send(page, drawer, "remind me in 150 seconds to edited route proof");
  const original = (await tasks(page)).find((t) => t.instruction === "edited route proof")!;
  await send(page, drawer, `send my edited route proof reminder to the ${side.title} chat`);
  let edited = (await tasks(page)).find((t) => t.id === original.id)!;
  expect(
    edited.destination,
    "kill gate: real economy model must extract a destination-only edit"
  ).toEqual({ threadId: sideId, title: side.title });
  expect(edited.dueAt).toBe(original.dueAt);
  expect(edited.instruction).toBe(original.instruction);
  console.log("[3148] destination-only run 1 changed Main to the named owned side chat");
  await send(page, drawer, "send my edited route proof reminder to Main");
  edited = (await tasks(page)).find((t) => t.id === original.id)!;
  expect(edited.destination).toBeUndefined();
  expect(edited.dueAt).toBe(original.dueAt);
  expect(edited.instruction).toBe(original.instruction);
  console.log("[3148] destination-only run 2 changed the side destination to Main");
  await send(
    page,
    drawer,
    `change my edited route proof reminder text to combined route proof and send it to the ${side.title} chat`
  );
  edited = (await tasks(page)).find((t) => t.id === original.id)!;
  expect(edited.destination, "stop if the real model refuses the combined edit").toEqual({
    threadId: sideId,
    title: side.title
  });
  expect(edited.instruction).toBe("combined route proof");
  expect(edited.dueAt).toBe(original.dueAt);
  console.log("[3148] combined text and destination edit passed through the real model once");
  console.log(
    "[3148] default Main from side, explicit this chat and destination-only edit saved through UI"
  );
  await drawer.getByLabel("Message Moss").fill("Side unsent draft");
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === defaultTask.id)?.state, {
      timeout: 90_000,
      intervals: [2000]
    })
    .toBe("completed");
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel("Message Moss")).toHaveValue("Side unsent draft");
  await expect(drawer.getByLabel("Message Moss")).toBeFocused();
  await send(page, drawer, "Reply briefly: how should I pack a small travel bag?");
  for (const saved of [explicit, edited]) {
    await expect
      .poll(async () => (await tasks(page)).find((t) => t.id === saved.id)?.state, {
        timeout: 90_000,
        intervals: [2000]
      })
      .toBe("completed");
    await expect(drawer.getByText(`Reminder: ${saved.instruction}`, { exact: true })).toHaveCount(
      1
    );
  }
  const sideResults = (await history(page, sideId)).filter(
    (m) => m.origin?.kind === "reminder" && m.origin.event === "delivered"
  );
  expect(
    sideResults.map((m) => (m.origin?.kind === "reminder" ? m.origin.reminderId : null)).sort()
  ).toEqual([explicit.id, edited.id].sort());
  const mainResults = (await history(page, main.id)).filter(
    (m) => m.origin?.kind === "reminder" && m.origin.event === "delivered"
  );
  expect(mainResults).toHaveLength(1);
  expect(mainResults[0]!.body).toBe("Reminder: default route proof");
  await select(drawer, "Main chat");
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Reminder: side route proof", { exact: true })).toHaveCount(0);
  await page.reload();
  drawer = await openChat(page);
  await select(drawer, side.title);
  await expect(drawer.getByText("Reminder: side route proof", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toHaveCount(0);
  console.log(
    "[3148] real queue results stay in exact durable histories and UI after switching and reload"
  );
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [mode, theme] of [
      ["light", "forest"],
      ["dark", "forest"],
      ["light", "teal"]
    ]) {
      await page.reload();
      await page.evaluate(
        ({ mode, theme }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.dataset.theme = theme;
        },
        { mode, theme }
      );
      await page.getByRole("button", { name: "Past tasks", exact: false }).click();
      await page.locator(`[data-task-id="${explicit.id}"]`).click();
      await expect(page.getByText(`Send results to ${side.title}`, { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.getByRole("button", { name: "Back to all tasks", exact: true }).click();
      console.log(`[3148] destination detail fits width=${width}, mode=${mode}, theme=${theme}`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  drawer = await openChat(page);
  const goneId = await startNewSideChat(page, drawer);
  await send(page, drawer, "Gone destination proof. Reply briefly: ready.");
  await send(page, drawer, "remind me in 60 seconds to gone route proof, send it to this chat");
  const gone = (await tasks(page)).find((t) => t.instruction === "gone route proof")!;
  await select(drawer, "Main chat");
  // The current drawer has no owner delete control; simulate target loss in this disposable only.
  const ownerId = (await threads(page)).find((t) => t.id === main.id)!.ownerUserId;
  const script = `import { createDatabase, DataContextRunner, getMossDatabaseUrls } from './packages/db/src/index.ts'; void (async () => { const db=createDatabase({connectionString:getMossDatabaseUrls().app}); try { await new DataContextRunner(db).withDataContext({actorUserId:${JSON.stringify(ownerId)}}, async scoped => { await scoped.db.deleteFrom('app.chat_threads').where('id','=',${JSON.stringify(goneId)}).execute(); }); } finally { await db.destroy(); } })();`;
  execFileSync(
    "docker",
    [
      ...buildUatComposeArgs(requireUatProjectName(), [
        "exec",
        "-T",
        "jarv1s",
        "node_modules/.bin/tsx",
        "-e",
        script
      ])
    ],
    { stdio: "pipe" }
  );
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === gone.id)?.state, {
      timeout: 90_000,
      intervals: [2000]
    })
    .toBe("failed");
  await expect(drawer.getByText("Reminder: gone route proof", { exact: true })).toHaveCount(0);
  expect((await history(page, main.id)).some((m) => m.body === "Reminder: gone route proof")).toBe(
    false
  );
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Past tasks", exact: false }).click();
  await page.locator(`[data-task-id="${gone.id}"]`).click();
  await expect(page.getByText(/set it again with an available chat or Main/)).toBeVisible();
  console.log(
    "[3148] simulated destination deletion under owner RLS: failed task visible, recovery guidance, no Main result"
  );
});
