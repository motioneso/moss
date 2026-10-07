import { spawn, type ChildProcess } from "node:child_process";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import {
  bringUpRealChatProvider,
  discoverCheapestChatModel,
  readUatJson,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

// #2809: live proof that chat re-runs a briefing without an approval card, refuses a second run
// while the first is open, and reports the finished run through briefings.getRunStatus.
//
// The app container runs the API, the chat helper and the worker together, so it cannot be
// paused without stopping chat, and a real model writes the briefing in seconds. The run is held
// open instead by a psql session holding an EXCLUSIVE lock on app.briefing_runs: reads still
// work, so chat and the status tool answer, but the worker blocks on inserting the finished run
// and its job stays open until the lock is released.
export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const POLL_DEADLINE_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;
const TZ = "America/Los_Angeles";
const HOLD_APP_NAME = "uat_2809_hold";

// The cheapest model sometimes reaches for the shell to look for a briefing before its Moss
// tools, and the CLI then waits on a shell approval. The steer keeps the proof on the Moss tools.
const TOOL_STEER = "Use your Moss briefing tools, not the shell.";
const RERUN_ASK = `Please re-run my evening briefing. ${TOOL_STEER}`;
const READY_ASK = `Is my evening briefing ready yet? ${TOOL_STEER}`;

async function ensureRealChat(page: Page): Promise<void> {
  await bringUpRealChatProvider(page);
  const cheapest = await discoverCheapestChatModel(page, POLL_DEADLINE_MS);
  await readUatJson(
    await page.request.put("/api/ai/services/chat/binding", {
      data: { binding: { kind: "model", modelId: cheapest.id } }
    })
  );
  await expect
    .poll(
      async () => {
        const body = (await readUatJson(
          await page.request.get("/api/ai/capability-route/chat")
        )) as { route: { available: boolean } };
        return body.route.available;
      },
      { timeout: POLL_DEADLINE_MS, message: "configured chat route did not become available" }
    )
    .toBe(true);
  console.log(`[2809 live proof] chat bound to the cheapest economy model ${cheapest.id}`);
}

function sqlRows(sql: string): string[][] {
  return execUatSql(requireUatProjectName(), sql)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|"));
}

async function holdRunInserts(): Promise<ChildProcess> {
  const hold = spawn(
    "docker",
    buildUatComposeArgs(requireUatProjectName(), [
      "exec",
      "-T",
      "-e",
      `PGAPPNAME=${HOLD_APP_NAME}`,
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-c",
      "BEGIN; LOCK TABLE app.briefing_runs IN EXCLUSIVE MODE; SELECT pg_sleep(900);"
    ]),
    { stdio: "ignore" }
  );
  await expect
    .poll(
      () =>
        sqlRows(
          "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid " +
            `WHERE a.application_name = '${HOLD_APP_NAME}' AND l.mode = 'ExclusiveLock' ` +
            "AND l.relation = 'app.briefing_runs'::regclass AND l.granted"
        )[0]?.[0],
      { timeout: 30_000, message: "the briefing_runs lock was never granted" }
    )
    .toBe("1");
  console.log("[2809 live proof] briefing run inserts held (EXCLUSIVE lock on briefing_runs)");
  return hold;
}

function releaseRunInserts(hold: ChildProcess): void {
  sqlRows(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
      `WHERE application_name = '${HOLD_APP_NAME}'`
  );
  hold.kill();
  console.log("[2809 live proof] briefing run inserts released");
}

function openRunJobs(definitionId: string): Array<{ id: string; state: string }> {
  return sqlRows(
    "SELECT id, state FROM pgboss.job WHERE name = 'briefings-run' " +
      `AND data->>'definitionId' = '${definitionId}' ` +
      "AND state IN ('created', 'retry', 'active') ORDER BY created_on"
  ).map(([id, state]) => ({ id: id!, state: state! }));
}

function rerunAuditRows(): Array<{ approvalMode: string; outcome: string }> {
  return sqlRows(
    "SELECT approval_mode, outcome FROM app.moss_action_audit_log " +
      `WHERE owner_user_id = '${UAT_ADMIN_ID}' AND tool_name = 'briefings.rerun' ` +
      "ORDER BY occurred_at"
  ).map(([approvalMode, outcome]) => ({ approvalMode: approvalMode!, outcome: outcome! }));
}

/** The thread text after the last copy of `message`, so earlier turns never satisfy a check. */
function afterLast(text: string, message: string): string {
  const at = text.lastIndexOf(message);
  if (at < 0) throw new Error(`sent message not found in the thread: ${message}`);
  return text.slice(at + message.length);
}

/**
 * Sends one message and returns what the turn added: `visible` is the rendered reply, `steps`
 * also holds the collapsed tool steps, which innerText skips.
 */
async function ask(dialog: Locator, message: string): Promise<{ visible: string; steps: string }> {
  const composer = dialog.getByRole("textbox", { name: "Message Moss" });
  await composer.fill(message);
  await composer.press("Enter");
  await expect(dialog.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 30_000
  });
  await expect(dialog.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: TURN_TIMEOUT_MS
  });
  const visible = afterLast(await dialog.innerText(), message);
  const steps = afterLast((await dialog.textContent()) ?? "", message);
  console.log(`[2809 live proof] turn "${message}" added:\n${visible.trim()}`);
  return { visible, steps };
}

async function newChat(page: Page, dialog: Locator): Promise<void> {
  const cleared = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/clear" &&
      response.status() === 204
  );
  await dialog.getByRole("button", { name: "New chat" }).click();
  await cleared;
}

test("chat re-runs the evening briefing once and reports it ready (#2809)", async ({
  page
}, testInfo) => {
  test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider");
  test.setTimeout(900_000);

  await signInUatAdmin(page);
  await ensureRealChat(page);

  // a. The seed has no evening briefing, so create one through the product's own API.
  const created = (await readUatJson(
    await page.request.post("/api/briefings/definitions", {
      data: {
        title: "#2809 evening",
        briefingType: "evening",
        cadence: "manual",
        enabled: true,
        scheduleMetadata: { targetTime: "18:00", timezone: TZ },
        selectedToolNames: ["tasks.list"]
      }
    })
  )) as { definition: { id: string } };
  const definitionId = created.definition.id;
  console.log(`[2809 live proof] evening briefing created: ${definitionId}`);
  expect(openRunJobs(definitionId)).toHaveLength(0);

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog).toBeVisible();

  const hold = await holdRunInserts();
  try {
    // b. First ask: the tool runs with no approval card and Moss says it queued.
    const first = await ask(dialog, RERUN_ASK);
    await expect(
      dialog.getByRole("status").filter({ hasText: "Executed: briefings.rerun" })
    ).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(first.visible).toMatch(/queued|started|kicked off|re-?running|being written|underway/i);
    expect(rerunAuditRows()).toEqual([{ approvalMode: "auto", outcome: "success" }]);
    const afterFirst = openRunJobs(definitionId);
    console.log(`[2809 live proof] open jobs after first ask: ${JSON.stringify(afterFirst)}`);
    expect(afterFirst).toHaveLength(1);
    await dialog.screenshot({ path: testInfo.outputPath("b-first-rerun.png") });

    // c. A fresh conversation asks again while the run is still open, so the model cannot answer
    // from memory and has to call the tool: already running, and still exactly one open job.
    await newChat(page, dialog);
    const second = await ask(dialog, RERUN_ASK);
    await expect(
      dialog.getByRole("status").filter({ hasText: "Executed: briefings.rerun" })
    ).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(second.visible).toMatch(/already/i);
    const audit = rerunAuditRows();
    console.log(`[2809 live proof] re-run tool audit rows: ${JSON.stringify(audit)}`);
    expect(audit).toEqual([
      { approvalMode: "auto", outcome: "success" },
      { approvalMode: "auto", outcome: "success" }
    ]);
    const afterSecond = openRunJobs(definitionId);
    console.log(`[2809 live proof] open jobs after second ask: ${JSON.stringify(afterSecond)}`);
    expect(afterSecond.map((job) => job.id)).toEqual(afterFirst.map((job) => job.id));
    await dialog.screenshot({ path: testInfo.outputPath("c-already-running.png") });
  } finally {
    releaseRunInserts(hold);
  }

  // d. Once the run lands, Moss reads it back through the status tool.
  let summaryText = "";
  await expect
    .poll(
      async () => {
        const body = (await readUatJson(
          await page.request.get(`/api/briefings/definitions/${definitionId}/runs`)
        )) as { runs: Array<{ status: string; summaryText: string }> };
        summaryText = body.runs[0]?.summaryText ?? "";
        return body.runs.map((run) => run.status);
      },
      { timeout: 180_000, message: "the re-run never produced a briefing run row" }
    )
    .toEqual(["succeeded"]);
  expect(openRunJobs(definitionId)).toHaveLength(0);
  console.log(
    `[2809 live proof] exactly one new evening briefing run row, succeeded; summary begins: ` +
      summaryText.slice(0, 160)
  );

  const third = await ask(dialog, READY_ASK);
  expect(third.visible).toMatch(/ready|done|finished|complete/i);
  expect(third.steps).toMatch(/getRunStatus/i);
  expect(rerunAuditRows()).toHaveLength(2);
  await dialog
    .locator("details.chatd-peek")
    .last()
    .evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
  await dialog.screenshot({ path: testInfo.outputPath("d-ready.png") });
});
