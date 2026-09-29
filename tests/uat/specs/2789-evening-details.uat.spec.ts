import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2789: evening finished items carry a grounded note, and the planning side column names real
// gaps and folds Moss task blocks already on tomorrow's calendar.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const TZ = "America/Los_Angeles";
const execFileAsync = promisify(execFile);

function localDay(date: Date): string {
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

function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}

function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

const TODAY = localDay(new Date());
const TOMORROW = shiftDay(TODAY, 1);
const EVENING_NOW = new Date(localIso(TODAY, "20:30"));

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT fixture target");
  return project;
}

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
  await page.goto(baseURL());
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

async function seedCalendarEvent(input: {
  accountId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  externalId: string;
  mossBlock: boolean;
}): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{await new CalendarRepository().upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(input.accountId)},title:${JSON.stringify(input.title)},startsAt:new Date(${JSON.stringify(input.startsAt)}),endsAt:new Date(${JSON.stringify(input.endsAt)}),externalId:${JSON.stringify(input.externalId)},externalMetadata:{jarvisCreated:${input.mossBlock}}});});}finally{await runner.destroy();} console.log(JSON.stringify({seeded:${JSON.stringify(input.title)}}));})();`;
  const result = await execFileAsync(
    "docker",
    buildUatComposeArgs(uatProject(), [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "--eval",
      script
    ]),
    { maxBuffer: 1_000_000 }
  );
  console.log(`[2789 calendar fixture] ${result.stdout.trim()}`);
}

test("evening finished items and planning side column carry grounded notes", async ({
  page
}, testInfo) => {
  test.setTimeout(240_000);
  await page.clock.setFixedTime(EVENING_NOW);
  await signIn(page);

  const definition = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "#2789 evening",
      briefingType: "evening",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "18:00", timezone: TZ },
      selectedToolNames: ["tasks.list"]
    })
  });
  expect(definition.status).toBe(201);
  const started = await json(
    page,
    `/api/briefings/definitions/${definition.body.definition.id}/run`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  expect(started.status).toBe(202);
  let reportReady = false;
  for (let attempt = 0; attempt < 60 && !reportReady; attempt++) {
    const listed = await json(
      page,
      `/api/briefings/definitions/${definition.body.definition.id}/runs`
    );
    const run = (
      listed.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((candidate) => candidate.id === started.body.runId);
    if (run && ["blocked", "failed"].includes(run.status)) {
      throw new Error(`evening report failed: ${JSON.stringify(run)}`);
    }
    reportReady = Boolean(run?.summaryText.trim());
    if (!reportReady) await page.waitForTimeout(1_000);
  }
  expect(reportReady).toBe(true);

  // Finished tasks: one with a description, one without.
  for (const [title, description] of [
    ["#2789 described done", "Sent to the team"],
    ["#2789 plain done", null]
  ] as const) {
    const created = await json(page, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, dueAt: null })
    });
    expect(created.status).toBe(201);
    const done = await json(page, `/api/tasks/${created.body.task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" })
    });
    expect(done.status).toBe(200);
  }

  // Tomorrow: a dentist visit, then a Moss task block that already sits on the calendar.
  const accounts = await json(page, "/api/connectors/accounts");
  const account = (accounts.body.accounts as Array<{ id: string; providerId: string }>).find(
    (candidate) => candidate.providerId === "google"
  );
  expect(account, "UAT seed must expose a Google account").toBeTruthy();
  await seedCalendarEvent({
    accountId: account!.id,
    title: "#2789 dentist",
    startsAt: localIso(TOMORROW, "09:00"),
    endsAt: localIso(TOMORROW, "09:45"),
    externalId: "2789-dentist",
    mossBlock: false
  });
  await seedCalendarEvent({
    accountId: account!.id,
    title: "#2789 old moss block",
    startsAt: localIso(TOMORROW, "16:00"),
    endsAt: localIso(TOMORROW, "16:30"),
    externalId: `jfb${"a".repeat(32)}`,
    mossBlock: true
  });
  const settings = await json(page, "/api/calendar/briefing-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeBlockMode: "suggest" })
  });
  expect(settings.status).toBe(200);

  await page.goto("/today");
  const recap = page.locator("#evening-recap");
  const described = recap.locator(".ev-done", { hasText: "#2789 described done" });
  const plain = recap.locator(".ev-done", { hasText: "#2789 plain done" });
  await expect(described.locator(".ev-done__sub")).toHaveText("Sent to the team");
  await expect(plain.locator(".ev-done__sub")).toHaveText(/^Completed at \d{1,2}:\d{2} (am|pm)$/);
  await testInfo.attach("finished-items", { body: await recap.innerText() });

  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const rail = dialog.locator(".evening-plan__railwrap");
  await expect(rail).toContainText("#2789 dentist");

  // The Moss block sits in the fold, not in the main list.
  const fold = rail.locator("details.evening-plan__existing-blocks");
  await expect(fold.locator("summary")).toHaveText("Existing calendar task blocks");
  await expect(
    rail.locator(".evening-plan__snapshot-entry", { hasText: "old moss block" })
  ).toHaveCount(0);
  await fold.locator("summary").click();
  await expect(fold).toContainText("#2789 old moss block");

  // No proposed blocks yet, so no invented gap notes.
  await expect(rail).not.toContainText("Room to get home and have lunch.");
  await expect(rail).not.toContainText("between task blocks");
  await testInfo.attach("side-column-empty", { body: await rail.innerText() });

  // Pick two tomorrow commitments and a steady day so proposed blocks appear in the column.
  const ids: string[] = [];
  for (const title of ["#2789 plan one", "#2789 plan two"]) {
    const created = await json(page, "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, dueAt: localIso(TODAY, "23:30") })
    });
    expect(created.status).toBe(201);
    ids.push(created.body.task.id as string);
  }
  await page.reload();
  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  await dialog.getByRole("button", { name: "Open commitments →" }).click();
  for (const title of ["#2789 plan one", "#2789 plan two"]) {
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
  await dialog.getByLabel("The one thing that matters").selectOption(ids[0]!);
  const drafts = rail.locator(".evening-plan__snapshot-entry--draft");
  await expect(drafts.first()).toBeVisible();
  // Whatever notes show must match the real times shown in the column.
  const text = await rail.innerText();
  await testInfo.attach("side-column-with-blocks", { body: text });
  console.log(`[2789 side column with blocks]\n${text}`);
  await expect(fold.locator("summary")).toHaveText("Existing calendar task blocks");

  for (const [name, width, height] of [
    ["1440", 1440, 900],
    ["375", 375, 800]
  ] as const) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `no sideways scroll at ${name}`).toBeLessThanOrEqual(0);
    await dialog.screenshot({ path: `/tmp/2789-shots/dialog-${name}.png` });
  }
});
