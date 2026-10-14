import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { ListScheduledTasksResponse } from "@moss/shared";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
async function send(page: Page, drawer: Locator, text: string): Promise<void> {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").fill(text);
  await expect(drawer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await drawer.getByLabel("Message Moss").press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(drawer.getByText(text, { exact: true })).toBeVisible();
}

test("real reminder has Settings details, history and a saved result on desktop and phone", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.log(`[3133] real Claude model tier=${model.tier} active=${model.status}`);
  await page.goto(`${requireUatBaseURL()}/settings`);
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  await expect(page.getByText("Nothing scheduled yet", { exact: true })).toBeVisible();
  console.log("[3133] fresh-account empty state reached from Settings navigation");
  let drawer = await openChat(page);
  await send(page, drawer, "Reply briefly: ready for reminder proof.");
  await send(page, drawer, "remind me in 1 minute to **Settings proof stretch**");
  await expect(drawer.getByText(/Okay\. I'll remind you in 1 minute/)).toBeVisible();
  const saved = (await readUatJson(
    await page.request.get("/api/chat/scheduled-tasks")
  )) as ListScheduledTasksResponse;
  const task = saved.tasks.find((item) => item.instruction === "**Settings proof stretch**")!;
  expect(task.state).toBe("active");
  expect(task.runs).toEqual([]);
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.reload();
  await page.locator(`[data-task-id="${task.id}"]`).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Schedule", { exact: true })).toBeVisible();
  await expect(page.getByText(/Hasn't run yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  console.log(
    "[3133] chat-created reminder shows active instruction/timing, no made-up runs and available lifecycle controls"
  );
  // Real worker time: wait for the real record to change, not a fake window focus event.
  await expect
    .poll(
      async () => {
        const response = (await readUatJson(
          await page.request.get("/api/chat/scheduled-tasks")
        )) as ListScheduledTasksResponse;
        return response.tasks.find((item) => item.id === task.id)?.state;
      },
      { timeout: 120_000, intervals: [3000] }
    )
    .toBe("completed");
  await page.reload();
  const past = page.getByRole("button", { name: "Past tasks", exact: true });
  await expect(past).toHaveAttribute("aria-expanded", "false");
  await past.click();
  await page.locator(`[data-task-id="${task.id}"]`).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Schedule", { exact: true })).toHaveCount(0);
  const history = page.getByRole("region", { name: "Run history" });
  await expect(history.locator("time")).toHaveAttribute("datetime", /T/);
  await history.locator("summary").click();
  drawer = await openChat(page);
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat" }).click();
  await send(page, drawer, "Reply briefly: side conversation proof.");
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await history.getByRole("button", { name: "View message" }).click();
  const result = page.getByRole("dialog", { name: "**Settings proof stretch**", exact: true });
  await expect(result.locator(".chatd-md strong")).toHaveText("Settings proof stretch");
  const project = requireUatProjectName();
  try {
    const failedRefresh = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/api/chat/scheduled-tasks"
    });
    execFileSync("docker", buildUatComposeArgs(project, ["stop", "jarv1s"]));
    await failedRefresh;
    // Allow the real five-second refresh and its retry to finish against the stopped service.
    await page.waitForTimeout(20_000);
    await expect(result).toBeVisible();
    await expect(result.locator(".chatd-md strong")).toHaveText("Settings proof stretch");
    await expect(page.getByText("Couldn't load your tasks", { exact: true })).toHaveCount(0);
    await result.getByRole("button", { name: "Close message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to all tasks" })).toBeVisible();
    await page.getByRole("button", { name: "Back to all tasks" }).click();
    await expect(page.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
    await page.locator(`[data-task-id="${task.id}"]`).click();
    await history.locator("summary").click();
    await history.getByRole("button", { name: "View message" }).click();
    await expect(result).toBeVisible();
    console.log("[3133] real refresh outage preserves the message dialog, detail and cached list");
  } finally {
    execFileSync(
      "docker",
      buildUatComposeArgs(project, ["up", "-d", "--no-deps", "--no-recreate", "--wait", "jarv1s"])
    );
  }
  const completed = (await readUatJson(
    await page.request.get("/api/chat/scheduled-tasks")
  )) as ListScheduledTasksResponse;
  const message = completed.tasks.find((item) => item.id === task.id)!.runs[0]!.message!;
  expect(completed.tasks.find((item) => item.id === task.id)!.runs).toHaveLength(1);
  const resumed = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/chat/threads/${message.threadId}/resume`
  );
  await result.getByRole("button", { name: "Open chat" }).click();
  expect((await resumed).ok()).toBe(true);
  drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
  await expect(
    drawer.locator(".chatd-md strong").filter({ hasText: "Settings proof stretch" }).last()
  ).toBeVisible();
  const historyResponse = (await readUatJson(
    await page.request.get(`/api/chat/threads/${message.threadId}/messages?surface=drawer`)
  )) as { messages: readonly { id: string }[] };
  expect(historyResponse.messages.filter((item) => item.id === message.id)).toHaveLength(1);
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  console.log(
    "[3133] worker delivered once; reload shows collapsed Past tasks, real dated history and Markdown result; Open chat resumed the result's actual thread"
  );
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
      await expect(page.getByText("Completed", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await history.getByRole("button", { name: "View message" }).click();
      await expect(result.locator(".chatd-md strong")).toHaveText("Settings proof stretch");
      await result.getByRole("button", { name: "Close message" }).click();
      console.log(`[3133] result/details fit width=${width}, mode=${mode}, theme=${theme}`);
    }
  }
});
