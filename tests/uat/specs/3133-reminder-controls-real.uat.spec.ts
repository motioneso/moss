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
async function closeChat(drawer: Locator) {
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
}

// Real clock, real worker, real saved records; there is no network interception.
test("pause, resume and confirmed deletion use the same reminder on desktop and phone", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  await page.goto(`${requireUatBaseURL()}/settings`);
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  let drawer = await openChat(page);
  await send(page, drawer, "Reply briefly: ready for reminder controls proof.");
  await send(page, drawer, "remind me in 90 seconds to controls proof stretch");
  const saved = (await tasks(page)).find((row) => row.instruction === "controls proof stretch")!;
  expect(saved.state).toBe("active");
  await closeChat(drawer);
  await page.reload();
  await page.locator(`[data-task-id="${saved.id}"]`).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  expect((await tasks(page)).find((row) => row.id === saved.id)?.runs).toEqual([]);
  console.log("[3133B] desktop Settings paused the chat-created record; no run history was added");

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [mode, theme] of [
      ["light", "forest"],
      ["dark", "forest"],
      ["light", "teal"]
    ]) {
      await page.evaluate(
        ({ mode, theme }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.dataset.theme = theme;
        },
        { mode, theme }
      );
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Delete task", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Delete task?", exact: true });
      await expect(dialog.getByRole("button", { name: "Keep task", exact: true })).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await dialog.getByRole("button", { name: "Keep task", exact: true }).click();
      console.log(
        `[3133B] controls and safe confirmation fit width=${width}, mode=${mode}, theme=${theme}`
      );
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  drawer = await openChat(page);
  await send(page, drawer, "resume my reminder to controls proof stretch");
  await expect
    .poll(async () => (await tasks(page)).find((row) => row.id === saved.id)?.state)
    .toBe("active");
  await send(page, drawer, "pause my reminder to controls proof stretch");
  await expect
    .poll(async () => (await tasks(page)).find((row) => row.id === saved.id)?.state)
    .toBe("paused");
  await closeChat(drawer);
  // Observe the real paused interval past the saved due time, allowing one worker poll.
  await page.waitForTimeout(Math.max(0, Date.parse(saved.dueAt) - Date.now()) + 12_000);
  const paused = (await tasks(page)).find((row) => row.id === saved.id)!;
  expect(paused.state).toBe("paused");
  expect(paused.runs).toEqual([]);
  console.log(
    "[3133B] phone chat pause/resume changed the same ID; paused reminder did not fire past its due time"
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect
    .poll(async () => (await tasks(page)).find((row) => row.id === saved.id)?.state, {
      timeout: 120_000,
      intervals: [3000]
    })
    .toBe("completed");
  await page.reload();
  await page.getByRole("button", { name: "Past tasks", exact: true }).click();
  await page.locator(`[data-task-id="${saved.id}"]`).click();
  const history = page.getByRole("region", { name: "Run history" });
  await expect(history.locator("time")).toHaveCount(1);
  await history.locator("summary").click();
  await history.getByRole("button", { name: "View message", exact: true }).click();
  const result = page.getByRole("dialog", { name: "controls proof stretch", exact: true });
  await expect(result).toContainText("controls proof stretch");
  await result.getByRole("button", { name: "Close message", exact: true }).click();
  drawer = await openChat(page);
  await send(page, drawer, "resume my reminder to controls proof stretch");
  await page.waitForTimeout(12_000);
  expect((await tasks(page)).find((row) => row.id === saved.id)?.runs).toHaveLength(1);
  const message = (await tasks(page)).find((row) => row.id === saved.id)?.runs[0]?.message;
  expect(message).toBeTruthy();
  const transcript = (await readUatJson(
    await page.request.get(`/api/chat/threads/${message!.threadId}/messages`)
  )) as ListChatThreadMessagesResponse;
  expect(
    transcript.messages.filter(
      (row) =>
        row.origin?.kind === "reminder" &&
        row.origin.event === "delivered" &&
        row.origin.reminderId === saved.id
    )
  ).toHaveLength(1);

  console.log(
    "[3133B] overdue resume delivered once; dated history and saved result opened on phone"
  );

  await send(page, drawer, "remind me in 5 minutes to controls proof chat delete");
  const chatDelete = (await tasks(page)).find(
    (row) => row.instruction === "controls proof chat delete"
  )!;
  await send(page, drawer, "delete my reminder to controls proof chat delete");
  expect((await tasks(page)).some((row) => row.id === chatDelete.id)).toBe(true);
  await send(page, drawer, "no");
  expect((await tasks(page)).some((row) => row.id === chatDelete.id)).toBe(true);
  await send(page, drawer, "remove my reminder to controls proof chat delete");
  await send(page, drawer, "yes");
  expect((await tasks(page)).some((row) => row.id === chatDelete.id)).toBe(false);
  await send(page, drawer, "remind me in 5 minutes to controls proof settings delete");
  const settingsDelete = (await tasks(page)).find(
    (row) => row.instruction === "controls proof settings delete"
  )!;
  await closeChat(drawer);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.locator(`[data-task-id="${settingsDelete.id}"]`).click();
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete task?", exact: true });
  await expect(confirmation.getByRole("button", { name: "Keep task", exact: true })).toBeFocused();
  await confirmation.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(page.getByText("Nothing scheduled yet", { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await tasks(page)).some((row) => row.id === settingsDelete.id))
    .toBe(false);
  expect((await tasks(page)).find((row) => row.id === saved.id)?.runs).toHaveLength(1);
  console.log(
    "[3133B] chat delete waited for typed yes; Settings deletion used Keep task focus and retained earlier result/history"
  );
});
