import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  ListScheduledTasksResponse,
  ListChatThreadsResponse,
  ListChatThreadMessagesResponse,
  ListActivityLinesResponse
} from "@moss/shared";
import { execUatSql } from "./job-search-board-sql.js";
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
  await expect
    .poll(
      () =>
        page.request.get("/health/ready").then(
          (response) => response.ok(),
          () => false
        ),
      { timeout: 60_000 }
    )
    .toBe(true);
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
  const inertText = `tell Alex to send the results to the ${side.title} chat`;
  await send(page, drawer, `remind me in 20 minutes to ${inertText}`);
  const inertTask = (await tasks(page)).find((t) => t.instruction === inertText);
  expect(inertTask).toBeDefined();
  expect(inertTask!.destination).toBeUndefined();
  console.log("[3148] embedded delivery wording stays intact and defaults to Main");
  await send(page, drawer, "remind me in 150 seconds to edited route proof");
  const original = (await tasks(page)).find((t) => t.instruction === "edited route proof")!;
  const combinedRequests = [
    "change my edited route proof reminder text to combined route proof",
    "move my edited route proof reminder to 20 minutes from now",
    "change my edited route proof reminder to repeat every day",
    "change my edited route proof reminder stop time to tomorrow"
  ];
  for (const [index, request] of combinedRequests.entries()) {
    await send(page, drawer, `${request} and send it to the ${side.title} chat`);
    await expect(
      drawer.getByText(
        "Change the destination in its own message. Nothing changed. Then send any text, time, repeat or stop-time edit separately.",
        { exact: true }
      )
    ).toHaveCount(index + 1);
    expect((await tasks(page)).find((t) => t.id === original.id)).toEqual(original);
  }
  console.log("[3148] combined text/time/repeat/stop edits refused; full saved task unchanged");
  await send(page, drawer, `send my edited route proof reminder to the ${side.title} chat`);
  let edited = (await tasks(page)).find((t) => t.id === original.id)!;
  expect(edited.destination).toEqual({ threadId: sideId, title: side.title });
  expect(edited.instruction).toBe(original.instruction);
  expect(edited.dueAt).toBe(original.dueAt);
  await send(page, drawer, "send my edited route proof reminder to Main");
  edited = (await tasks(page)).find((t) => t.id === original.id)!;
  expect(edited.destination).toBeUndefined();
  expect(edited.dueAt).toBe(original.dueAt);
  expect(edited.instruction).toBe(original.instruction);
  console.log("[3148] destination-only edits passed from Main to side and back to Main");
  await send(page, drawer, "remind me in 90 seconds to default route proof");
  const defaultTask = (await tasks(page)).find((t) => t.instruction === "default route proof")!;
  expect(defaultTask.destination).toBeUndefined();
  await send(page, drawer, "remind me in 150 seconds to side route proof, send it to this chat");
  const explicit = (await tasks(page)).find((t) => t.instruction === "side route proof")!;
  expect(explicit.destination).toEqual({ threadId: sideId, title: side.title });
  console.log(
    "[3148] default Main from side, explicit this chat and destination-only edit saved through UI"
  );
  await drawer.getByLabel("Message Moss").fill("Side unsent draft");
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === defaultTask.id)?.state, {
      timeout: 120_000,
      intervals: [2000]
    })
    .toBe("completed");
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toHaveCount(0);
  await expect(drawer.getByLabel("Message Moss")).toHaveValue("Side unsent draft");
  await expect(drawer.getByLabel("Message Moss")).toBeFocused();
  for (const saved of [explicit]) {
    await expect
      .poll(async () => (await tasks(page)).find((t) => t.id === saved.id)?.state, {
        timeout: 90_000,
        intervals: [2000]
      })
      .toBe("completed");
    await expect(drawer.getByText(`Reminder: ${saved.instruction}`, { exact: true })).toHaveCount(
      1
    );
    await expect(drawer.getByLabel("Message Moss")).toHaveValue("Side unsent draft");
    await expect(drawer.getByLabel("Message Moss")).toBeFocused();
  }
  const sideResults = (await history(page, sideId)).filter(
    (m) => m.origin?.kind === "reminder" && m.origin.event === "delivered"
  );
  expect(
    sideResults.map((m) => (m.origin?.kind === "reminder" ? m.origin.reminderId : null)).sort()
  ).toEqual([explicit.id]);
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === edited.id)?.state, {
      timeout: 90_000
    })
    .toBe("completed");
  const finalMainResults = (await history(page, main.id)).filter(
    (m) => m.origin?.kind === "reminder" && m.origin.event === "delivered"
  );
  expect(finalMainResults.map((m) => m.body).sort()).toEqual(
    ["Reminder: default route proof", "Reminder: edited route proof"].sort()
  );
  await select(drawer, "Main chat");
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Reminder: edited route proof", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Reminder: side route proof", { exact: true })).toHaveCount(0);
  await page.reload();
  drawer = await openChat(page);
  await select(drawer, side.title);
  await expect(drawer.getByText("Reminder: side route proof", { exact: true })).toHaveCount(1);
  await expect(drawer.getByText("Reminder: edited route proof", { exact: true })).toHaveCount(0);
  await expect(drawer.getByText("Reminder: default route proof", { exact: true })).toHaveCount(0);
  console.log(
    "[3148] real queue results stay in exact durable histories and UI after switching and reload"
  );
  await send(
    page,
    drawer,
    "remind me in 60 seconds to reconnect route proof, send it to this chat"
  );
  const reconnectTask = (await tasks(page)).find((t) => t.instruction === "reconnect route proof")!;
  await drawer.getByLabel("Message Moss").fill("Reconnect unsent draft");
  await page.context().setOffline(true);
  try {
    // Offline blocks new requests but can leave an established SSE socket alive; close it for real.
    execFileSync("docker", buildUatComposeArgs(requireUatProjectName(), ["restart", "jarv1s"]), {
      stdio: "pipe",
      timeout: 90_000
    });
    await expect
      .poll(
        () =>
          page.request.get("/health/ready").then(
            (response) => response.ok(),
            () => false
          ),
        { timeout: 60_000, intervals: [2000] }
      )
      .toBe(true);
    // APIRequestContext stays online while the browser's new stream requests are blocked.
    await expect
      .poll(async () => (await tasks(page)).find((t) => t.id === reconnectTask.id)?.state, {
        timeout: 90_000,
        intervals: [2000]
      })
      .toBe("completed");
    await expect(drawer.getByText("Reminder: reconnect route proof", { exact: true })).toHaveCount(
      0
    );
    const reconnected = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/chat/stream" && response.ok(),
      { timeout: 60_000 }
    );
    await page.context().setOffline(false);
    await reconnected;
    await expect(drawer.getByText("Reminder: reconnect route proof", { exact: true })).toHaveCount(
      1
    );
    await expect(drawer.getByLabel("Message Moss")).toHaveValue("Reconnect unsent draft");
    await expect(drawer.getByLabel("Message Moss")).toBeFocused();
  } finally {
    await page.context().setOffline(false);
  }
  const reconnectResults = (await history(page, sideId)).filter(
    (m) =>
      m.origin?.kind === "reminder" &&
      m.origin.event === "delivered" &&
      m.origin.reminderId === reconnectTask.id
  );
  expect(reconnectResults).toHaveLength(1);
  await page.reload();
  drawer = await openChat(page);
  await select(drawer, side.title);
  await expect(drawer.getByText("Reminder: reconnect route proof", { exact: true })).toHaveCount(1);
  expect(
    (await history(page, sideId)).filter((m) => m.id === reconnectResults[0]!.id)
  ).toHaveLength(1);
  console.log(
    "[3148] real SSE reconnect catches up once; draft, focus and durable identity preserved"
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
  // Ben approved this disposable bootstrap-only fault fixture; normal runtime DELETE stays revoked.
  const ownerId = (await threads(page)).find((t) => t.id === main.id)!.ownerUserId;
  for (const id of [ownerId, goneId]) expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(
    execUatSql(
      requireUatProjectName(),
      `DELETE FROM app.chat_threads WHERE id = '${goneId}' AND owner_user_id = '${ownerId}' AND NOT is_main AND NOT incognito AND surface = 'drawer' RETURNING id`
    ).trim()
  ).toBe(goneId);
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
    "[3148] disclosed disposable bootstrap target deletion: owner paths show failed task, recovery guidance, no Main result"
  );
  drawer = await openChat(page);
  await select(drawer, side.title);
  await send(
    page,
    drawer,
    "remind me in 60 seconds to overlapping route proof, send it to this chat"
  );
  const overlapTask = (await tasks(page)).find((t) => t.instruction === "overlapping route proof")!;
  expect(Date.parse(overlapTask.dueAt)).toBeGreaterThan(Date.now());
  expect((await page.request.post(`/api/chat/scheduled-tasks/${overlapTask.id}/pause`)).ok()).toBe(
    true
  );
  expect((await tasks(page)).find((t) => t.id === overlapTask.id)).toMatchObject({
    instruction: overlapTask.instruction,
    destination: overlapTask.destination,
    dueAt: overlapTask.dueAt,
    state: "paused"
  });
  await expect
    .poll(() => Date.parse(overlapTask.dueAt) - Date.now(), {
      timeout: 90_000,
      intervals: [1000]
    })
    .toBeLessThanOrEqual(0);
  const packingPrompt =
    "Write a detailed travel packing guide with 40 numbered tips, each with two full sentences. Start with a tip about a small travel bag. Do not use tools.";
  const replyBubbles = drawer.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble");
  const repliesBeforePacking = await replyBubbles.count();
  const overlapObservation = drawer.evaluate(
    (root, repliesBeforePacking) =>
      new Promise<{
        reason: "arrival" | "timeout";
        elapsedMs: number;
        stopVisible: boolean;
        partialText: string;
      }>((resolve) => {
        const armedAt = Date.now();
        const observer = new MutationObserver(observe);
        const timeout = setTimeout(() => finish("timeout", false, ""), 30_000);
        function finish(reason: "arrival" | "timeout", stopVisible: boolean, partialText: string) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve({ reason, elapsedMs: Date.now() - armedAt, stopVisible, partialText });
        }
        function observe() {
          const bubbles = Array.from(
            root.querySelectorAll(".chatd-msg:not(.chatd-msg--me) .chatd-bubble")
          );
          const visible = (element: Element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden";
          if (
            !bubbles.some(
              (bubble) =>
                visible(bubble) &&
                bubble.textContent?.trim() === "Reminder: overlapping route proof"
            )
          )
            return;
          const stop = root.querySelector('button[aria-label="Stop generating"]');
          const stopVisible = !!stop && visible(stop);
          const partialText =
            bubbles
              .slice(repliesBeforePacking)
              .filter(
                (bubble) => visible(bubble) && /packing|travel|bag/i.test(bubble.textContent ?? "")
              )
              .at(-1)?.textContent ?? "";
          finish("arrival", stopVisible, partialText);
        }
        observer.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
        observe();
      }),
    repliesBeforePacking
  );
  const packingResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").fill(packingPrompt);
  await drawer.getByLabel("Message Moss").press("Enter");
  await expect(drawer.getByRole("button", { name: "Stop generating", exact: true })).toBeVisible();
  // Release the overdue reminder through normal owner controls only after real text is streaming.
  await expect
    .poll(
      () =>
        drawer.evaluate((root, previousCount) => {
          const visible = (element: Element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== "hidden";
          const stop = root.querySelector('button[aria-label="Stop generating"]');
          const partial = Array.from(
            root.querySelectorAll(".chatd-msg:not(.chatd-msg--me) .chatd-bubble")
          )
            .slice(previousCount)
            .some(
              (bubble) => visible(bubble) && /packing|travel|bag/i.test(bubble.textContent ?? "")
            );
          return !!stop && visible(stop) && partial;
        }, repliesBeforePacking),
      { timeout: 30_000, intervals: [50] }
    )
    .toBe(true);
  expect((await page.request.post(`/api/chat/scheduled-tasks/${overlapTask.id}/resume`)).ok()).toBe(
    true
  );
  expect((await tasks(page)).find((t) => t.id === overlapTask.id)).toMatchObject({
    instruction: overlapTask.instruction,
    destination: overlapTask.destination,
    dueAt: overlapTask.dueAt
  });
  const observed = await overlapObservation;
  console.log("[3148] overlap observation", {
    reason: observed.reason,
    elapsedMs: observed.elapsedMs,
    stopVisible: observed.stopVisible,
    partialLength: observed.partialText.length
  });
  expect(observed.reason).toBe("arrival");
  expect(
    observed.stopVisible,
    "the real reply must still be running when the reminder arrives"
  ).toBe(true);
  expect(observed.partialText).toMatch(/packing|travel|bag/i);
  await expect(drawer.getByText("Reminder: overlapping route proof", { exact: true })).toHaveCount(
    1
  );
  const packing = await packingResponse;
  expect(packing.ok()).toBe(true);
  const packingBody = (await packing.json()) as { reply: string; assistantMessageId: string };
  expect(packingBody.reply.length).toBeGreaterThan(100);
  await expect(replyBubbles).toHaveCount(repliesBeforePacking + 2);
  await expect(
    replyBubbles
      .nth(repliesBeforePacking)
      .or(replyBubbles.nth(repliesBeforePacking + 1))
      .filter({ hasText: /packing|travel|bag/i })
  ).toHaveCount(1);
  const overlapHistory = await history(page, sideId);
  expect(overlapHistory.filter((m) => m.id === packingBody.assistantMessageId)).toHaveLength(1);
  expect(overlapHistory.find((m) => m.id === packingBody.assistantMessageId)?.body).toBe(
    packingBody.reply
  );
  expect(
    overlapHistory.filter(
      (m) =>
        m.origin?.kind === "reminder" &&
        m.origin.event === "delivered" &&
        m.origin.reminderId === overlapTask.id
    )
  ).toHaveLength(1);
  console.log("[3148] shown-side reminder arrived once during an observed real model reply");
  const activity = (await readUatJson(
    await page.request.get("/api/ai/activity-lines?limit=100")
  )) as ListActivityLinesResponse;
  const modelCalls = activity.entries.filter((entry) =>
    ["chat", "structured"].includes(entry.kind)
  );
  expect(modelCalls.filter((entry) => entry.kind === "chat").length).toBeGreaterThan(0);
  for (const call of modelCalls) expect(call.modelName).toBe(model.providerModelId);
  console.log("[3148] executed chat activity records confirm the selected economy model");
});
