// Supplemental real seeded-owner login, NOT signup. No interception, forced model,
// recurrence, due-worker wait or fault injection. See the dedicated runner protocol.
import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatLocaleDateTime,
  type ListScheduledTasksResponse,
  type LocaleSettingsDto
} from "@moss/shared";
import { requireFallbackObserver } from "../run-scheduled-read-terminal-uat.js";
import {
  completeWindow,
  receiptSha256,
  requestWindow,
  type WindowMode
} from "../n3-window-handshake.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

interface RefusalReceipt {
  admitted: boolean;
  structuredOk: number;
  ordinary: number;
  assistants: number;
  refused: boolean;
  stored: boolean;
  reminderDelta: number;
  sourceDelta: number;
  jobDelta: number;
}
function assertRefusal(r: RefusalReceipt): void {
  assert(r.admitted && r.structuredOk >= 1, "no admitted successful interpretation evidence");
  assert(
    r.ordinary === 0 && r.assistants === 1 && r.refused && r.stored,
    "terminal persisted refusal absent"
  );
  assert(r.reminderDelta === 0 && r.sourceDelta === 0 && r.jobDelta === 0, "refusal created work");
}
interface SavedReceipt {
  owner: string;
  expectedOwner: string;
  item: string;
  expectedItem: string;
  repeat: string | null;
  due: number;
  submitted: number;
  finished: number;
  reminders: number;
  sources: number;
  jobs: number;
  ordinary: number;
  structuredOk: number;
}
function assertSaved(r: SavedReceipt): void {
  assert(r.owner === r.expectedOwner && r.item === r.expectedItem, "saved identity mismatch");
  assert(
    r.repeat === null && Math.abs(r.due - r.submitted - 30 * 60_000) <= 90_000,
    "saved timing mismatch"
  );
  assert(r.finished < r.due - 10 * 60_000, "proof too close to due time");
  assert(
    r.reminders === 1 && r.sources === 1 && r.jobs === 1 && r.ordinary === 0 && r.structuredOk >= 1,
    "saved terminal inventory mismatch"
  );
}
function domainControls(): void {
  let controls = 0;
  const refusal: RefusalReceipt = {
    admitted: true,
    structuredOk: 1,
    ordinary: 0,
    assistants: 1,
    refused: true,
    stored: true,
    reminderDelta: 0,
    sourceDelta: 0,
    jobDelta: 0
  };
  assertRefusal(refusal);
  controls++;
  for (const [key, value] of Object.entries({
    admitted: false,
    structuredOk: 0,
    ordinary: 1,
    assistants: 2,
    refused: false,
    stored: false,
    reminderDelta: 1,
    sourceDelta: 1,
    jobDelta: 1
  })) {
    assert.throws(() => assertRefusal({ ...refusal, [key]: value }));
    controls++;
  }
  const saved: SavedReceipt = {
    owner: "a",
    expectedOwner: "a",
    item: "b",
    expectedItem: "b",
    repeat: null,
    submitted: 0,
    due: 1_800_000,
    finished: 10_000,
    reminders: 1,
    sources: 1,
    jobs: 1,
    ordinary: 0,
    structuredOk: 1
  };
  assertSaved(saved);
  controls++;
  for (const [key, value] of Object.entries({
    owner: "foreign",
    item: "wrong",
    repeat: "interval",
    due: 1000,
    finished: 1_700_000,
    reminders: 0,
    sources: 2,
    jobs: 0,
    ordinary: 1,
    structuredOk: 0
  })) {
    assert.throws(() => assertSaved({ ...saved, [key]: value }));
    controls++;
  }
  console.info(`N3 fake-only domain controls PASS (${controls}); no live effects`);
}
const REFUSED =
  "I didn't set a check. Name one task you own and one supported time or cadence; I can only read its status.";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function sqlJson<T>(sql: string): T {
  return JSON.parse(execUatSql(requireUatProjectName(), sql).trim()) as T;
}
interface Inventory {
  reminders: string[];
  sources: string[];
  jobs: string[];
}
function inventory(): Inventory {
  return sqlJson(`SELECT json_build_object(
    'reminders', (SELECT coalesce(json_agg(id ORDER BY id), '[]') FROM app.chat_reminders WHERE owner_user_id='${UAT_ADMIN_ID}'),
    'sources', (SELECT coalesce(json_agg(reminder_id ORDER BY reminder_id), '[]') FROM app.chat_scheduled_reads WHERE owner_user_id='${UAT_ADMIN_ID}'),
    'jobs', (SELECT coalesce(json_agg(id ORDER BY id), '[]') FROM pgboss.job WHERE data->>'actorUserId'='${UAT_ADMIN_ID}' AND name IN ('chat.scheduled-read','chat.deliver-reminder')))`);
}
function added(before: string[], after: string[]): string[] {
  return after.filter((id) => !before.includes(id));
}
interface Outcome {
  assistants: number;
  stored: boolean;
  refused: boolean;
  ordinary: number;
  structuredOk: number;
  assistantId: string | null;
  userId: string | null;
  reminderId: string | null;
  saved: boolean;
}
function outcome(since: string): Outcome {
  // Completed chat activity is supplemental only; it cannot prove zero attempts.
  // Bounded metadata/booleans only: never select prompts, bodies, auth or activity detail.
  return sqlJson(`WITH messages AS (
    SELECT * FROM app.chat_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND created_at >= '${since}'::timestamptz
  ) SELECT json_build_object(
    'assistants', (SELECT count(*) FROM messages WHERE role='assistant'),
    'stored', (SELECT coalesce(bool_and(status='stored'),false) FROM messages WHERE role='assistant'),
    'refused', (SELECT coalesce(bool_and(body='${REFUSED.replaceAll("'", "''")}' AND model_metadata->'origin'= '{"version":1,"kind":"reminder","event":"refused","reminderId":null}'::jsonb AND NOT model_metadata ? 'executed'),false) FROM messages WHERE role='assistant'),
    'saved', (SELECT coalesce(bool_and(model_metadata->'origin'->>'event'='saved' AND model_metadata->'origin'->>'kind'='reminder' AND NOT model_metadata ? 'executed'),false) FROM messages WHERE role='assistant'),
    'assistantId', (SELECT id FROM messages WHERE role='assistant' LIMIT 1),
    'userId', (SELECT id FROM messages WHERE role='user' LIMIT 1),
    'reminderId', (SELECT model_metadata->'origin'->>'reminderId' FROM messages WHERE role='assistant' LIMIT 1),
    'ordinary', (SELECT count(*) FROM app.moss_model_activity_log WHERE owner_user_id='${UAT_ADMIN_ID}' AND occurred_at >= '${since}'::timestamptz AND kind='chat'),
    'structuredOk', (SELECT count(*) FROM app.moss_model_activity_log WHERE owner_user_id='${UAT_ADMIN_ID}' AND occurred_at >= '${since}'::timestamptz AND kind='structured' AND action_code='structured.chat' AND outcome='ok'))`);
}
function databaseNow(): string {
  return sqlJson<{ now: string }>("SELECT json_build_object('now',clock_timestamp())").now;
}
let windowSeq = 0;
function mainThreadId(): string | null {
  return sqlJson<{ id: string | null }>(`SELECT coalesce(
    (SELECT json_build_object('id',id) FROM app.chat_threads
      WHERE owner_user_id='${UAT_ADMIN_ID}' AND surface='drawer' AND is_main),
    json_build_object('id',NULL))`).id;
}
/**
 * One chat turn inside one observer window. The worker opens the window before the message is
 * sent and closes it with these receipts; any missing acknowledgement fails the test.
 */
async function sendInMain(page: Page, text: string, mode: WindowMode): Promise<void> {
  const evidence = process.env.N3_UAT_EVIDENCE!;
  const seq = ++windowSeq;
  await page.goto("/today");
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  if (!(await composer.isVisible()))
    await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(composer).toBeEnabled({ timeout: 120_000 });
  // The window needs the thread the turn will land in, so it must already exist.
  await expect.poll(mainThreadId, { timeout: 15_000 }).toMatch(UUID);
  await requestWindow(evidence, {
    seq,
    actorUserId: UAT_ADMIN_ID,
    threadId: mainThreadId()!,
    mode
  });
  const received = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await composer.fill(text);
  await composer.press("Enter");
  const response = await received;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    userMessageId?: string;
    assistantMessageId?: string;
  };
  expect(body.userMessageId).toMatch(UUID);
  expect(body.assistantMessageId).toMatch(UUID);
  await expect(composer).toBeEnabled({ timeout: 120_000 });
  await expect(composer).toHaveValue("");
  const ids = { user: body.userMessageId!, assistant: body.assistantMessageId! };
  await completeWindow(evidence, {
    seq,
    turnId: ids.assistant,
    http: {
      status: response.status(),
      finished: true,
      receiptSha256: receiptSha256({ path: "/api/chat/turn", status: response.status(), ...ids })
    },
    ui: {
      finished: true,
      receiptSha256: receiptSha256({ composerEnabled: true, composerEmpty: true, ...ids })
    }
  });
}
function admittedRefusal(since: string): boolean {
  // Raw log collection remains in memory/private child output, never published.
  // This event can only occur after recognized interpretation was attempted.
  const result = spawnSync(
    "docker",
    ["logs", "--since", since, "--tail", "1000", `${requireUatProjectName()}-jarv1s-1`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  expect(result.status).toBe(0);
  const raw = `${result.stdout}\n${result.stderr}`;
  return raw.split("\n").some((line) => {
    try {
      const row = JSON.parse(line) as { event?: string; stage?: string };
      return row.event === "chat.scheduled_read_refused" && row.stage === "item_selection";
    } catch {
      return false;
    }
  });
}

if (process.argv.includes("--self-test")) domainControls();
else
  test("#3529 admitted missing-task refusal and one saved owned check stay terminal", async ({
    page
  }) => {
    requireFallbackObserver(); // Fail closed until correlated attempt coverage exists.
    test.setTimeout(8 * 60_000);
    expect(process.env.JARVIS_GATE_RUN).toBe("1");
    expect(process.env.N3_UAT_EVIDENCE).toBeTruthy();
    expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
    expect(process.env.JARVIS_UAT_REAL_CHAT_PROVIDER).toBe("codex");
    expect(process.env.MOSS_UAT_REAL_CHAT_MODEL).toBeUndefined();
    await signInUatAdmin(page);
    const model = await bringUpRealChatModel(page);
    expect(model.tier).toBe("economy");
    // Harmless positive: a plain reply, the one window allowed to show provider attempts.
    await sendInMain(page, "Reply with the single word ready.", "positive");
    const title = `N3 owned task ${Date.now()}`;
    await page.goto("/tasks");
    const capture = page.getByRole("textbox", { name: "Task title" });
    await capture.fill(title);
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST"
    );
    await capture.press("Enter");
    const response = await created;
    expect(response.status()).toBe(201);
    const { task } = (await response.json()) as { task: { id: string } };
    expect(task.id).toMatch(UUID);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    const before = inventory();
    const missingAt = databaseNow();
    await sendInMain(
      page,
      `Check the status of my task N3 nonexistent task ${Date.now()} in 30 minutes`,
      "terminal"
    );
    await expect(page.getByText(REFUSED, { exact: true }).last()).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(() => outcome(missingAt).structuredOk, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const refused = outcome(missingAt);
    const after = inventory();
    expect(after).toEqual(before);
    const refusal = {
      ...refused,
      admitted: admittedRefusal(missingAt),
      reminderDelta: added(before.reminders, after.reminders).length,
      sourceDelta: added(before.sources, after.sources).length,
      jobDelta: added(before.jobs, after.jobs).length
    };
    assertRefusal(refusal);
    // Reload proves the persisted terminal reply survives beyond the turn response.
    await page.reload();
    const composer = page.getByRole("textbox", { name: "Message Moss" });
    if (!(await composer.isVisible()))
      await page.getByRole("button", { name: "Chat with Moss" }).click();
    await expect(page.getByText(REFUSED, { exact: true }).last()).toBeVisible();
    const savedAt = databaseNow();
    await sendInMain(page, `Check the status of my task ${title} in 30 minutes`, "terminal");
    const confirmation = `I'll check ${title} once in 1800 seconds and report its status here.`;
    await expect(page.getByText(confirmation, { exact: true }).last()).toBeVisible({
      timeout: 120_000
    });
    await expect
      .poll(() => outcome(savedAt).structuredOk, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const saved = outcome(savedAt);
    expect(saved.assistants).toBe(1);
    expect(saved.stored).toBe(true);
    expect(saved.saved).toBe(true);
    expect(saved.reminderId).toMatch(UUID);
    const id = saved.reminderId!;
    interface SavedRow {
      owner: string;
      item: string;
      repeat: string | null;
      due: string;
      job: string;
      state: string;
      operation: string;
      sourceOwner: string;
      sourceOutcome: string | null;
      jobState: string;
      startAfter: string;
      main: boolean;
      thread: string;
    }
    const row =
      sqlJson<SavedRow>(`SELECT json_build_object('owner',r.owner_user_id,'item',s.item_id,
    'repeat',r.repeat_kind,'due',r.due_at,'job',j.id,'state',r.state,'operation',s.operation,'thread',r.thread_id,
    'sourceOwner',s.owner_user_id,'sourceOutcome',s.outcome,'jobState',j.state,'startAfter',j.start_after,'main',t.is_main)
    FROM app.chat_reminders r JOIN app.chat_scheduled_reads s ON s.reminder_id=r.id
    JOIN pgboss.job j ON j.data->>'resourceId'=r.id::text AND j.name='chat.scheduled-read'
    JOIN app.chat_threads t ON t.id=r.thread_id AND t.owner_user_id=r.owner_user_id
    WHERE r.id='${id}' AND j.data->>'actorUserId'='${UAT_ADMIN_ID}'`);
    expect(row.state).toBe("queued");
    expect(row.operation).toBe("tasks.get");
    expect(row.sourceOwner).toBe(UAT_ADMIN_ID);
    expect(row.sourceOutcome).toBeNull();
    expect(row.jobState).toBe("created");
    expect(row.main).toBe(true);
    expect(Date.parse(row.startAfter)).toBe(Date.parse(row.due));
    expect(
      sqlJson<{ owner: string }>(
        `SELECT json_build_object('owner',owner_user_id) FROM app.tasks WHERE id='${task.id}'`
      ).owner
    ).toBe(UAT_ADMIN_ID);
    expect(row.job).toMatch(UUID);
    const finalInventory = inventory();
    assertSaved({
      owner: row.owner,
      expectedOwner: UAT_ADMIN_ID,
      item: row.item,
      expectedItem: task.id,
      repeat: row.repeat,
      due: Date.parse(row.due),
      submitted: Date.parse(savedAt),
      finished: Date.now(),
      reminders: added(after.reminders, finalInventory.reminders).length,
      sources: added(after.sources, finalInventory.sources).length,
      jobs: added(after.jobs, finalInventory.jobs).length,
      ordinary: saved.ordinary,
      structuredOk: saved.structuredOk
    });
    await page.goto("/settings?section=scheduled");
    await page.getByRole("button", { name: `Check task status: ${title}`, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `Check task status: ${title}`, exact: true })
    ).toBeVisible();
    await expect(page.locator(".scheduled-task-detail")).toContainText("Active");
    await expect(page.locator(".scheduled-task-detail")).toContainText("Schedule");
    const settingsResponse = await page.request.get("/api/chat/scheduled-tasks");
    expect(settingsResponse.ok()).toBe(true);
    const settings = (await settingsResponse.json()) as ListScheduledTasksResponse;
    const detail = settings.tasks.find((candidate) => candidate.id === id);
    expect(detail).toMatchObject({
      id,
      state: "active",
      schedule: null,
      dueAt: new Date(row.due).toISOString()
    });
    expect(detail?.title).toBe(`Check task status: ${title}`);
    const localeResponse = await page.request.get("/api/me/locale");
    expect(localeResponse.ok()).toBe(true);
    const { locale } = (await localeResponse.json()) as { locale: LocaleSettingsDto };
    await expect(page.locator(".scheduled-task-detail")).toContainText(
      formatLocaleDateTime(row.due, locale)
    );
    // UI deletion removes the temporary scheduled check before its due time. The
    // source task and any retained cancellation row die with the isolated stack.
    await page.getByRole("button", { name: "Delete task", exact: true }).click();
    const deleted = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/chat/scheduled-tasks/${id}` &&
        r.request().method() === "DELETE"
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete task", exact: true })
      .click();
    expect((await deleted).ok()).toBe(true);
    await expect
      .poll(
        () =>
          sqlJson<{ state: string }>(
            `SELECT json_build_object('state',state) FROM app.chat_reminders WHERE id='${id}'`
          ).state
      )
      .toBe("cancelled");
    expect(Date.now()).toBeLessThan(Date.parse(row.due) - 10 * 60_000);
    writeFileSync(
      join(process.env.N3_UAT_EVIDENCE!, "proof.json"),
      JSON.stringify(
        {
          signup: "OUTSTANDING",
          seededLogin: "supplemental",
          owner: UAT_ADMIN_ID,
          taskId: task.id,
          modelId: model.id,
          tier: model.tier,
          refusal,
          saved,
          reminderId: id,
          jobId: row.job,
          threadId: row.thread,
          submitted: savedAt,
          due: row.due,
          settings: { id: detail!.id, state: detail!.state, dueAt: detail!.dueAt },
          cleanup: "UI cancelled check; stack destruction still required",
          telemetry: "metadata observations, not raw upstream counts or cap enforcement"
        },
        null,
        2
      ) + "\n",
      { mode: 0o600, flag: "wx" }
    );
  });
