import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { ListScheduledTasksResponse, ScheduledTaskDto } from "@moss/shared";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
async function readCheck(page: Page, id: string): Promise<ScheduledTaskDto> {
  const { tasks } = (await readUatJson(
    await page.request.get("/api/chat/scheduled-tasks")
  )) as ListScheduledTasksResponse;
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error("Disposable recurring check is missing");
  return task;
}
async function send(page: Page, text: string) {
  await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
  await drawer.getByLabel("Message Moss").fill(text);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(
    drawer.getByText("The first check will establish a quiet baseline", { exact: false })
  ).toBeVisible({ timeout: 120_000 });
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
}
function workerCommand(script: string) {
  return execFileSync(
    "docker",
    [
      ...buildUatComposeArgs(requireUatProjectName(), [
        "exec",
        "-T",
        "jarv1s",
        "node",
        "-e",
        script
      ])
    ],
    { encoding: "utf8" }
  ).trim();
}
function identifyWorker() {
  return Number(
    workerCommand(
      "const fs=require('fs'); const p=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('dist/worker.js')}catch{return false}});if(p.length!==1)throw Error('Expected one resident worker');console.log(p[0])"
    )
  );
}

test("real recurring Tasks check stays quiet, posts one real change and recovers saved cadence", async ({
  page
}) => {
  test.setTimeout(900_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  console.info(`[3138] configured economy model=${model.id}, tier=${model.tier}`);
  expect(model.tier).toBe("economy");
  await page.goto("/settings?section=alerts");
  await page.getByLabel("Quiet hours from").fill("00:00");
  await page.getByLabel("Quiet hours until").fill("23:59");
  if (!(await page.getByLabel("Enable quiet hours").isChecked()))
    await page
      .locator("label.jds-switch")
      .filter({ has: page.getByLabel("Enable quiet hours") })
      .click();
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(page.getByText("Quiet hours saved.")).toBeVisible();
  const title = `Recurring status proof ${Date.now()}`;
  await page.goto("/tasks");
  const creation = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "POST"
  );
  await page.getByRole("textbox", { name: "Task title" }).fill(title);
  await page.getByRole("textbox", { name: "Task title" }).press("Enter");
  expect((await creation).status()).toBe(201);
  await send(page, `Check the status of my task ${title} every 60 seconds`);
  const { tasks } = (await readUatJson(
    await page.request.get("/api/chat/scheduled-tasks")
  )) as ListScheduledTasksResponse;
  const saved = tasks.find((t) => t.instruction === `Check task status: ${title}`)!;
  expect(saved).toBeDefined();
  expect(saved.schedule).toBe("Every 1 minute");
  await page.goto("/settings?section=scheduled");
  await page.locator(`[data-task-id="${saved.id}"]`).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await readCheck(page, saved.id)).runs.length, {
      timeout: 100_000,
      intervals: [2000]
    })
    .toBe(1);
  expect((await readCheck(page, saved.id)).runs[0]).toMatchObject({
    outcome: "quiet",
    message: null
  });
  await page.reload();
  await page.locator(`[data-task-id="${saved.id}"]`).click();
  await expect(
    page.getByText("Task checked successfully; nothing new to report", { exact: false }).first()
  ).toBeVisible();
  console.info("[3138] real Settings history retained quiet baseline without a chat result");
  await page.goto("/tasks");
  const change = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH"
  );
  await page.locator(".tk-task", { hasText: title }).first().locator("label.jds-check").click();
  expect((await change).ok()).toBe(true);
  await expect
    .poll(
      async () => (await readCheck(page, saved.id)).runs.filter((r) => r.message !== null).length,
      { timeout: 150_000, intervals: [2000] }
    )
    .toBe(1);
  const reported = await readCheck(page, saved.id);
  expect(reported.runs.find((r) => r.message !== null)?.message?.scheduledReadSource).toBe("tasks");
  await page.getByRole("button", { name: "Chat with Moss", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
  await expect(drawer.getByRole("link", { name: "Source: Tasks" }).last()).toBeVisible();
  await expect(drawer.getByText(title, { exact: false }).last()).toBeVisible();
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect
    .poll(async () => (await readCheck(page, saved.id)).runs.length, {
      timeout: 100_000,
      intervals: [2000]
    })
    .toBeGreaterThan(reported.runs.length);
  const unchanged = await readCheck(page, saved.id);
  expect(unchanged.runs[0]).toMatchObject({ outcome: "quiet", message: null });
  expect(unchanged.runs.filter((r) => r.message !== null)).toHaveLength(1);
  console.info(
    "[3138] real source change produced one ordinary sourced result; unchanged check was quiet"
  );
  const pid = identifyWorker();
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  const before = await readCheck(page, saved.id);
  workerCommand(`process.kill(${pid}, 'SIGSTOP')`);
  try {
    await page.waitForTimeout(130_000);
    expect((await readCheck(page, saved.id)).runs).toHaveLength(before.runs.length);
  } finally {
    workerCommand(`process.kill(${pid}, 'SIGCONT')`);
  }
  await expect
    .poll(async () => (await readCheck(page, saved.id)).runs.length, {
      timeout: 30_000,
      intervals: [1000]
    })
    .toBe(before.runs.length + 1);
  const recovered = await readCheck(page, saved.id);
  expect(recovered.runs[0]).toMatchObject({ outcome: "quiet", message: null });
  expect(new Date(recovered.dueAt).getTime()).toBeGreaterThan(Date.now());
  const nextDue = new Date(recovered.dueAt).getTime();
  expect((nextDue - new Date(before.dueAt).getTime()) % 60_000).toBe(0);
  await expect
    .poll(async () => (await readCheck(page, saved.id)).runs.length, {
      timeout: 90_000,
      intervals: [2000]
    })
    .toBe(before.runs.length + 2);
  console.info(
    `[3138] one fresh check after worker downtime; resumed cadence next_due=${recovered.dueAt}`
  );
  await page.goto("/settings?section=scheduled");
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
      await page.locator(`[data-task-id="${saved.id}"]`).click();
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.getByRole("button", { name: "Back to all tasks", exact: true }).click();
      console.info(`[3138] recurrence/history DOM fits width=${width} mode=${mode} theme=${theme}`);
    }
  }
  await page.locator(`[data-task-id="${saved.id}"]`).click();
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete task?", exact: true });
  await expect(confirm.getByRole("button", { name: "Keep task" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(page.locator(`[data-task-id="${saved.id}"]`)).toHaveCount(0);
});
