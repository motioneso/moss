import { expect, test, type Page } from "@playwright/test";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { spawnSync } from "node:child_process";

function captureReadFailureKinds() {
  const logs = spawnSync(
    "docker",
    ["logs", "--tail", "1000", `${requireUatProjectName()}-jarv1s-1`],
    { encoding: "utf8" }
  );
  const records = `${logs.stdout}\n${logs.stderr}`
    .split("\n")
    .filter((line) => line.startsWith('{"event":"chat.scheduled_read_refused"'))
    .slice(-10);
  console.info(`Scheduled read failure kinds: ${JSON.stringify(records)}`);
}

async function sendInMain(page: Page, text: string) {
  await page.goto("/today");
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(composer).toBeEnabled({ timeout: 120_000 });
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await composer.fill(text);
  await composer.press("Enter");
  expect((await response).ok()).toBe(true);
  await expect(composer).toHaveValue("");
}

function captureJobState(itemId: string): string {
  const state = execUatSql(
    requireUatProjectName(),
    `
    SELECT json_build_object('captured_at', clock_timestamp(),
      'reminder_state', r.state, 'version', r.version, 'outcome', s.outcome,
      'message_body', m.body, 'message_thread', m.thread_id, 'reminder_thread', r.thread_id,
      'message_created_at', m.created_at, 'reminder_created_at', r.created_at,
      'job_queue', j.name, 'job_state', j.state, 'job_output', j.output,
      'due_at', r.due_at, 'start_after', j.start_after,
      'job_started_on', to_jsonb(j)->>'started_on',
      'job_completed_on', to_jsonb(j)->>'completed_on',
      'retry_count', to_jsonb(j)->>'retry_count')
    FROM app.chat_scheduled_reads s
    JOIN app.chat_reminders r ON r.id = s.reminder_id
    LEFT JOIN app.chat_messages m ON m.id = r.reserved_message_id
    LEFT JOIN pgboss.job j ON j.data->>'resourceId' = r.id::text
    WHERE s.item_id = '${itemId}'
  `
  );
  console.info(`Scheduled read job evidence: ${state}`);
  return state;
}

export async function proveScheduledSourceReport(page: Page) {
  test.setTimeout(600_000);
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/assets/"))
      console.info(`UAT asset request failed: ${path}: ${request.failure()?.errorText}`);
  });
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  expect(process.env.JARVIS_UAT_REAL_CHAT_PROVIDER ?? "codex").toBe("codex");
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  console.info(`Real model proof: Codex economy model ${model.id}`);
  test.info().annotations.push({ type: "real-model", description: `Codex: ${model.id}` });
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
  const title = `Scheduled source proof ${Date.now()}`;
  await page.goto("/tasks");
  const capture = page.getByRole("textbox", { name: "Task title" });
  await capture.fill(title);
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "POST"
  );
  await capture.press("Enter");
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const { task } = (await createdResponse.json()) as { task: { id: string } };
  expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await sendInMain(page, `Check the status of my task ${title} in 45 seconds`);
  await expect(page.getByText(`I'll check ${title} once`, { exact: false }).last())
    .toBeVisible({
      timeout: 120_000
    })
    .catch((error: unknown) => {
      captureReadFailureKinds();
      throw error;
    });
  await page.goto("/settings?section=scheduled");
  await page.getByRole("button", { name: `Check task status: ${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.goto("/tasks");
  const done = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH"
  );
  await page.locator(".tk-task", { hasText: title }).first().locator("label.jds-check").click();
  expect((await done).ok()).toBe(true);
  const context = page.context();
  await page.close();
  expect(context.pages()).toHaveLength(0);
  await expect
    .poll(
      () =>
        execUatSql(
          requireUatProjectName(),
          `SELECT s.outcome FROM app.chat_scheduled_reads s WHERE s.item_id = '${task.id}' AND s.outcome IS NOT NULL`
        ).trim(),
      { timeout: 150_000, intervals: [2_000, 5_000, 10_000] }
    )
    .toBe("success");
  console.info("Scheduled report persisted while every app page was closed.");
  page = await context.newPage();
  await page.goto("/today");
  if (!(await page.getByRole("textbox", { name: "Message Moss" }).isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(
    page
      .locator(".chatd-md")
      .filter({ has: page.getByRole("link", { name: "Source: Tasks" }) })
      .last()
  )
    .toBeVisible({ timeout: 120_000 })
    .catch((error: unknown) => {
      const state = captureJobState(task.id);
      throw new Error(`Scheduled read execution: ${state}`, { cause: error });
    });
  captureJobState(task.id);
  const report = page
    .locator(".chatd-md")
    .filter({ has: page.getByRole("link", { name: "Source: Tasks" }) })
    .last();
  await expect(report).toContainText(title);
  await expect(report).toContainText(/done|complete/i);
  await expect(page.getByRole("link", { name: "Source: Tasks" })).toHaveCount(1);
  const quiet = await page.request.get("/api/me/quiet-hours");
  expect((await quiet.json()).quietHours).toMatchObject({
    enabled: true,
    start: "00:00",
    end: "23:59"
  });
  const activity = execUatSql(
    requireUatProjectName(),
    `SELECT count(*) FROM app.moss_model_activity_log a WHERE a.kind = 'structured' AND a.outcome = 'ok' AND a.occurred_at >= (SELECT max(r.due_at) FROM app.chat_reminders r JOIN app.chat_scheduled_reads s ON s.reminder_id = r.id WHERE s.item_id = '${task.id}')`
  );
  expect(Number(activity.trim())).toBeGreaterThanOrEqual(1);
  console.info(`Scheduled report model activity after due: ${activity.trim()}`);
  await expect(page.getByRole("link", { name: "Source: Tasks" }).last()).toHaveAttribute(
    "href",
    "/tasks"
  );
  await page.reload();
  if (!(await page.getByRole("textbox", { name: "Message Moss" }).isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(
    page
      .locator(".chatd-md")
      .filter({ has: page.getByRole("link", { name: "Source: Tasks" }) })
      .last()
  ).toBeVisible();
  await sendInMain(page, "Reply briefly: I saw the task check.");
  await expect(page.getByRole("textbox", { name: "Message Moss" })).toBeEnabled({
    timeout: 120_000
  });
  await page.goto("/settings?section=scheduled");
  await page.getByRole("button", { name: "Past tasks" }).click();
  await page.getByRole("button", { name: `Check task status: ${title}`, exact: true }).click();
  await page.locator("summary").filter({ hasText: "Task status checked" }).click();
  await page.getByRole("button", { name: "View message" }).click();
  await expect(
    page
      .locator(".chatd-md")
      .filter({ has: page.getByRole("link", { name: "Source: Tasks" }) })
      .last()
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Source: Tasks" }).last()).toHaveAttribute(
    "href",
    "/tasks"
  );
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  const confirmations = page.getByText(`I'll check ${title} once`, { exact: false });
  await expect(confirmations.first()).toBeVisible();
  const savedCount = await confirmations.count();
  await sendInMain(page, `Check the status of my task ${title} in 45 seconds`);
  await expect(confirmations)
    .toHaveCount(savedCount + 1, { timeout: 120_000 })
    .catch((error: unknown) => {
      captureReadFailureKinds();
      throw error;
    });
  // Tasks is core with no disable/delete UI; remove only this disposable source as fault setup.
  execUatSql(requireUatProjectName(), `DELETE FROM app.tasks WHERE id = '${task.id}'`);
  await page.goto("/today");
  if (!(await page.getByRole("textbox", { name: "Message Moss" }).isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(
    page
      .getByText("I couldn't check that task because access is no longer available.", {
        exact: false
      })
      .last()
  )
    .toBeVisible({ timeout: 120_000 })
    .catch((error: unknown) => {
      throw new Error(`Scheduled read refusal: ${captureJobState(task.id)}`, { cause: error });
    });
  captureJobState(task.id);
  const refusal = page
    .locator(".chatd-md")
    .filter({ hasText: "I couldn't check that task because access is no longer available." })
    .last();
  await expect(refusal).not.toContainText(title);
  await expect(refusal).not.toContainText("done");
  await expect(refusal.getByRole("link", { name: "Source: Tasks" })).toHaveCount(0);
  await page.close();
}
