import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  ListScheduledTasksResponse,
  ScheduledTaskDto,
  ListChatThreadMessagesResponse
} from "@moss/shared";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatBaseURL,
  signInUatAdmin
} from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;

async function openChat(page: Page): Promise<Locator> {
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
async function tasks(page: Page): Promise<readonly ScheduledTaskDto[]> {
  return (
    (await readUatJson(
      await page.request.get("/api/chat/scheduled-tasks")
    )) as ListScheduledTasksResponse
  ).tasks;
}
async function close(drawer: Locator) {
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
}

// A real model, owner UI, queue and worker. No intercepted or rewritten network responses.
test("chat edits replace queued terms, appear in Settings and fire once at the revised time", async ({
  page
}) => {
  test.setTimeout(720_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.log(`[3135] real Codex CLI subscription model=${model.id}, tier=${model.tier}`);
  await page.goto(`${requireUatBaseURL()}/settings`);
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  let drawer = await openChat(page);
  await send(page, drawer, "Reply briefly: ready for reminder edit proof.");
  console.log(
    "[3135] " +
      (await drawer
        .getByRole("button", { name: /^Chat model:/ })
        .evaluate((button) => button.getAttribute("aria-label") ?? button.textContent))
  );
  await send(page, drawer, "remind me in 120 seconds to edit proof original");
  const original = (await tasks(page)).find((row) => row.instruction === "edit proof original")!;
  expect(original.state).toBe("active");
  await send(
    page,
    drawer,
    "change my edit proof original reminder text to edit proof revised and move it to 4 minutes from now"
  );
  const revised = (await tasks(page)).find((row) => row.id === original.id)!;
  expect(
    revised.instruction,
    "kill gate: the cheapest real model must interpret this ordinary edit"
  ).toBe("edit proof revised");
  expect(Date.parse(revised.dueAt)).toBeGreaterThan(Date.parse(original.dueAt) + 90_000);
  expect(revised.runs).toEqual([]);
  console.log(
    "[3135] real economy model changed one saved ID's text and moved its queued due time"
  );
  await close(drawer);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.locator(`[data-task-id="${original.id}"]`).click();
    await expect(
      page.getByRole("heading", { name: "edit proof revised", exact: true, level: 3 })
    ).toBeVisible();
    expect((await tasks(page)).find((row) => row.id === original.id)?.dueAt).toBe(revised.dueAt);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    console.log(
      `[3135] width=${width} Settings shows the revised record after reload; no Edit button`
    );
  }
  drawer = await openChat(page);
  await send(page, drawer, "remind me in 10 minutes to choice proof one");
  await send(page, drawer, "remind me in 10 minutes to choice proof two");
  const before = (await tasks(page)).filter((row) => row.instruction.startsWith("choice proof"));
  await send(
    page,
    drawer,
    "change my choice proof reminder text to chosen proof revised daily vitamins"
  );
  expect(
    (await tasks(page)).filter((row) => row.instruction.startsWith("choice proof"))
  ).toHaveLength(2);
  await expect(drawer.getByText(/Which reminder should I change/).last()).toBeVisible();
  await send(page, drawer, "2");
  const selected = (await tasks(page)).find((row) => row.id === before[1]!.id)!;
  expect(selected.instruction).toBe("chosen proof revised daily vitamins");
  await send(
    page,
    drawer,
    "change my chosen proof revised daily vitamins reminder to repeat daily"
  );
  expect((await tasks(page)).find((row) => row.id === selected.id)?.dueAt).toBe(selected.dueAt);
  await expect(
    drawer.getByText(/I can edit a reminder's text, time or deadline only/).last()
  ).toBeVisible();
  console.log(
    "[3135] ambiguous edits waited for a typed numbered choice; recurrence was refused unchanged"
  );
  await close(drawer);
  // Wait once across the old due time, then observe the real queue's state.
  await page.waitForTimeout(Math.max(0, Date.parse(original.dueAt) - Date.now()) + 12_000);
  const atOldTime = (await tasks(page)).find((row) => row.id === original.id)!;
  expect(atOldTime.state).toBe("active");
  expect(atOldTime.runs).toEqual([]);
  console.log("[3135] the original queued firing posted no message at its old due time");
  await expect
    .poll(async () => (await tasks(page)).find((row) => row.id === original.id)?.state, {
      timeout: Math.max(30_000, Date.parse(revised.dueAt) - Date.now() + 60_000),
      intervals: [3000]
    })
    .toBe("completed");
  const completed = (await tasks(page)).find((row) => row.id === original.id)!;
  expect(completed.runs).toHaveLength(1);
  const message = completed.runs[0]!.message!;
  const transcript = (await readUatJson(
    await page.request.get(`/api/chat/threads/${message.threadId}/messages`)
  )) as ListChatThreadMessagesResponse;
  const firings = transcript.messages.filter(
    (row) =>
      row.origin?.kind === "reminder" &&
      row.origin.event === "delivered" &&
      row.origin.reminderId === original.id
  );
  expect(firings).toHaveLength(1);
  expect(firings[0]!.body).toContain("edit proof revised");
  expect(firings[0]!.body).not.toContain("edit proof original");
  console.log("[3135] exactly one persisted revised message fired at the new time");
});
