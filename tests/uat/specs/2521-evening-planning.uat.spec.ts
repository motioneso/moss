import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2521 focused live-browser proof. The UAT provisioner installs a real provider
// configuration pointed at its in-network fixed-prose writer, so the run is
// generated through the worker and persisted before the UI is exercised.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const TZ = "America/Los_Angeles";
function localDay(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const SERVER_DAY = localDay();

function addDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      timeZoneName: "longOffset"
    })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}

const PLAN_DAY = addDay(SERVER_DAY);
const EVENING_NOW = new Date(localIso(SERVER_DAY, "20:30"));

async function json(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: await response.json() };
    },
    { path, init }
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

async function createTask(page: Page, title: string, dueAt: string): Promise<string> {
  const result = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt })
  });
  expect(result.status).toBe(201);
  return result.body.task.id as string;
}

async function createPersistedEveningBriefing(page: Page): Promise<string> {
  const definition = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "#2521 evening planning proof",
      briefingType: "evening",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "18:00", timezone: TZ },
      selectedToolNames: ["tasks.list"]
    })
  });
  expect(definition.status).toBe(201);
  const definitionId = definition.body.definition.id as string;

  const started = await json(page, `/api/briefings/definitions/${definitionId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  expect(started.status).toBe(202);
  const runId = started.body.runId as string;

  for (let attempt = 0; attempt < 60; attempt++) {
    const listed = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    expect(listed.status).toBe(200);
    const run = (
      listed.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((candidate) => candidate.id === runId);
    if (run?.summaryText.trim()) {
      expect(run.status).toBe("succeeded");
      expect(run.summaryText).toContain("A steady day with room for deep work.");
      return runId;
    }
    if (run && ["blocked", "failed"].includes(run.status)) {
      throw new Error(`UAT evening briefing did not succeed: ${JSON.stringify(run)}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("UAT evening briefing did not reach a populated terminal state");
}

async function setSuggestMode(page: Page): Promise<void> {
  const result = await json(page, "/api/calendar/briefing-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeBlockMode: "suggest" })
  });
  expect(result.status).toBe(200);
}

test("Steady and Full day save the expected blocks and preview unsaved placement", async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  await page.clock.setFixedTime(EVENING_NOW);
  await signIn(page);

  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  expect(locale.body.locale.timezone).toBe(TZ);
  const dueToday = localIso(SERVER_DAY, "23:30");
  const taskId = await createTask(page, "#2521 evening follow-up", dueToday);
  const followThroughTaskId = await createTask(page, "#2521 evening follow-through", dueToday);
  const extraTaskId = await createTask(page, "#2521 evening extra commitment", dueToday);
  const selectedTaskIds = [taskId, followThroughTaskId, extraTaskId];
  await setSuggestMode(page);
  const runId = await createPersistedEveningBriefing(page);

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await page.goto("/today");
  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".evening-plan__prose")).toContainText(
    "A steady day with room for deep work."
  );
  await dialog.getByRole("button", { name: "Open commitments →" }).click();
  for (const title of [
    "#2521 evening follow-up",
    "#2521 evening follow-through",
    "#2521 evening extra commitment"
  ]) {
    await dialog
      .getByRole("radiogroup", { name: `${title}: plan` })
      .getByLabel("Tomorrow")
      .click();
  }
  await dialog.getByRole("button", { name: "Shape tomorrow →" }).click();
  await dialog
    .getByRole("radiogroup", { name: "Day capacity" })
    .getByLabel(/A steady day/)
    .click();
  await dialog.getByLabel("The one thing that matters").selectOption(taskId);
  await dialog.getByRole("button", { name: "Review the plan →" }).click();
  await dialog.getByRole("button", { name: /^Save (tomorrow's|proposed) plan$/ }).click();
  await expect(dialog).toContainText("Saved. The blocks are proposed for the morning.");

  const planPath = `/api/calendar/day-plan?date=${PLAN_DAY}&timeZone=${encodeURIComponent(TZ)}`;
  const steadySaved = await json(page, planPath);
  expect(steadySaved.status).toBe(200);
  expect(steadySaved.body.plan.sourceRunId).toBe(runId);
  const steadyIds = (steadySaved.body.plan.blocks as Array<{ taskId: string | null }>)
    .filter((block) => selectedTaskIds.includes(block.taskId ?? ""))
    .map((block) => block.taskId);
  expect(steadyIds).toHaveLength(2);
  expect(steadyIds).toContain(taskId);

  await dialog.getByRole("button", { name: "Adjust this plan" }).click();
  await dialog
    .getByRole("radiogroup", { name: "Day capacity" })
    .getByLabel(/A full day/)
    .click();
  await dialog.getByRole("button", { name: "Review the plan →" }).click();
  await dialog.getByRole("button", { name: /^Save (tomorrow's|proposed) plan$/ }).click();
  await expect(dialog).toContainText("Saved. The blocks are proposed for the morning.");

  const fullSaved = await json(page, planPath);
  expect(fullSaved.status).toBe(200);
  const fullIds = (fullSaved.body.plan.blocks as Array<{ taskId: string | null }>)
    .filter((block) => selectedTaskIds.includes(block.taskId ?? ""))
    .map((block) => block.taskId)
    .sort();
  expect(fullIds).toEqual([...selectedTaskIds].sort());

  await dialog.getByRole("button", { name: "Adjust this plan" }).click();
  await dialog.getByRole("button", { name: "Review the plan →" }).click();
  await dialog.getByLabel("#2521 evening follow-up: placement").selectOption("add");
  const startTime = dialog.getByLabel("#2521 evening follow-up: start time");
  const beforeEdit = (
    fullSaved.body.plan.blocks as Array<{
      taskId: string | null;
      pendingChange: { startsAt: string } | null;
    }>
  ).find((block) => block.taskId === taskId)?.pendingChange?.startsAt;
  expect(beforeEdit).toBeTruthy();
  await startTime.fill("11:00");
  await expect(dialog.getByRole("heading", { name: "Proposed calendar changes" })).toBeVisible();
  await expect(dialog).toContainText(/Add “#2521 evening follow-up” at 11:00\./);

  const stillSaved = await json(page, planPath);
  const persistedStart = (
    stillSaved.body.plan.blocks as Array<{
      taskId: string | null;
      pendingChange: { startsAt: string } | null;
    }>
  ).find((block) => block.taskId === taskId)?.pendingChange?.startsAt;
  expect(persistedStart).toBe(beforeEdit);
  await testInfo.attach("unsaved-proposed-calendar-changes", {
    body: await dialog.screenshot(),
    contentType: "image/png"
  });

  await dialog.getByRole("button", { name: /^Save (tomorrow's|proposed) plan$/ }).click();
  await expect(dialog).toContainText("Saved. The blocks are proposed for the morning.");
  const placed = await json(page, planPath);
  const savedStart = (
    placed.body.plan.blocks as Array<{
      taskId: string | null;
      pendingChange: { startsAt: string } | null;
    }>
  ).find((block) => block.taskId === taskId)?.pendingChange?.startsAt;
  expect(savedStart).toBe(localIso(PLAN_DAY, "11:00"));

  console.log(
    `[2521 evening proof] head=${commit} run=${runId} steady=${steadyIds.length} full=${fullIds.length}; unsaved placement persisted only after save`
  );
});
