import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ListScheduledTasksResponse, ScheduledTaskDto } from "@moss/shared";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;

async function tasks(page: Page): Promise<readonly ScheduledTaskDto[]> {
  return (
    (await readUatJson(
      await page.request.get("/api/chat/scheduled-tasks")
    )) as ListScheduledTasksResponse
  ).tasks;
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
function inOwnContainer(script: string): string {
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

// The resident API remains live while only this disposable install's worker is stopped.
test("real repeating requests, saved groups and one catch-up after worker downtime", async ({
  page
}) => {
  test.setTimeout(720_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.log(`[3136] real Codex subscription model=${model.id}, tier=${model.tier}`);
  await page.goto(`${requireUatBaseURL()}/settings`);
  await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
  let drawer = await openChat(page);
  await send(
    page,
    drawer,
    "Reply briefly: I walk every Monday and practice daily. What is a good way to stay consistent?"
  );
  expect(await tasks(page)).toHaveLength(0);
  console.log(
    "[3136] everyday day/week language reached the real model without creating a schedule"
  );
  await send(page, drawer, "remind me every day at 9am to daily proof stretch");
  await send(page, drawer, "remind me every Monday at 9am to weekly proof water plants");
  await send(page, drawer, "remind me every 120 seconds to interval proof stand up");
  const saved = await tasks(page);
  const daily = saved.find((t) => t.instruction === "daily proof stretch")!;
  const weekly = saved.find((t) => t.instruction === "weekly proof water plants")!;
  const interval = saved.find((t) => t.instruction === "interval proof stand up")!;
  expect([daily.group, weekly.group, interval.group]).toEqual(["Daily", "Weekly", "More often"]);
  await send(
    page,
    drawer,
    "change my interval proof stand up reminder to repeat every 60 seconds starting in 60 seconds"
  );
  expect((await tasks(page)).find((t) => t.id === interval.id)?.schedule).toBe("Every 1 minute");
  await send(
    page,
    drawer,
    "change my interval proof stand up reminder text to interval proof drink water"
  );
  expect((await tasks(page)).find((t) => t.id === interval.id)?.instruction).toBe(
    "interval proof drink water"
  );
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.reload();
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
      for (const group of ["Daily", "Weekly", "More often"])
        await expect(page.getByRole("heading", { name: group, exact: true })).toBeVisible();
      await page.locator(`[data-task-id="${daily.id}"]`).click();
      await expect(page.getByText("When clocks change", { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          "A skipped local time moves forward by the gap. A repeated local time fires once, at its earlier occurrence.",
          { exact: true }
        )
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`repeating-${width}-${mode}-${theme}.png`)
      });
      console.log(
        `[3136] groups and cadence details fit width=${width}, mode=${mode}, theme=${theme}`
      );
      await page.getByRole("button", { name: "Back to all tasks", exact: true }).click();
    }
  }
  const pid = Number(
    inOwnContainer(
      "const fs=require('fs');const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('dist/worker.js')}catch{return false}});if(pids.length!==1)throw Error('Expected one resident worker');console.log(pids[0])"
    )
  );
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  inOwnContainer(`process.kill(${pid},'SIGSTOP')`);
  const before = (await tasks(page)).find((t) => t.id === interval.id)!;
  try {
    await page.waitForTimeout(190_000);
    const held = (await tasks(page)).find((t) => t.id === interval.id)!;
    expect(held.runs).toHaveLength(before.runs.length);
    expect(held.dueAt).toBe(before.dueAt);
  } finally {
    inOwnContainer(`process.kill(${pid},'SIGCONT')`);
  }
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === interval.id)?.runs.length, {
      timeout: 30_000,
      intervals: [2000]
    })
    .toBe(before.runs.length + 1);
  const caught = (await tasks(page)).find((t) => t.id === interval.id)!;
  expect(Date.parse(caught.dueAt)).toBeGreaterThan(Date.now());
  expect(caught.runs[0]!.message!.body).toContain("interval proof drink water");
  console.log(
    "[3136] worker resumed after three missed intervals: one persisted catch-up, next time still on the saved phase"
  );
  await expect
    .poll(async () => (await tasks(page)).find((t) => t.id === interval.id)?.runs.length, {
      timeout: 80_000,
      intervals: [2000]
    })
    .toBe(before.runs.length + 2);
  drawer = await openChat(page);
  await send(page, drawer, "cancel the reminder to interval proof drink water");
  const stopped = (await tasks(page)).find((t) => t.id === interval.id)!;
  expect(stopped.state).toBe("cancelled");
  await page.waitForTimeout(70_000);
  expect((await tasks(page)).find((t) => t.id === interval.id)?.runs).toHaveLength(
    stopped.runs.length
  );
  console.log(
    "[3136] next normal firing persisted separately; cancellation prevented the following firing"
  );
});
