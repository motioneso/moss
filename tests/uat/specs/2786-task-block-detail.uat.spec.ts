import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2786: Today's schedule task blocks. A committed Moss-planned block carries a "Flexible" tag, a
// first-time suggestion says "Proposed" (not "Change pending"), and a preparation block that ends
// when a real calendar event starts names that event. The test seeds its own tasks, calendar
// event and plan on the isolated UAT instance and checks 1440 and 375 widths.
export const uatLevel = { level: "multi-user", without: [] } as const;

const TZ = "America/Los_Angeles";
const execFileAsync = promisify(execFile);

function localDay(date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}
const SERVER_DAY = localDay();
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
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}
async function createTask(page: Page, title: string, dueAt: string | null = null): Promise<string> {
  const r = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt })
  });
  expect(r.status).toBe(201);
  return r.body.task.id as string;
}
async function armCalendar(page: Page): Promise<string> {
  const accounts = await json(page, "/api/connectors/accounts");
  expect(accounts.status).toBe(200);
  const account = (accounts.body.accounts as Array<{ id: string; providerId: string }>).find(
    (a) => a.providerId === "google"
  );
  expect(account, "UAT seed must expose a Google account").toBeTruthy();
  const r = await json(page, `/api/connectors/accounts/${account!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenPayload: {
        kind: "google-oauth",
        clientId: "t22-client",
        clientSecret: "t22-secret",
        accessToken: "t22-access",
        refreshToken: "t22-refresh",
        tokenExpiry: "2099-01-01T00:00:00.000Z",
        grantedScopes: ["https://www.googleapis.com/auth/calendar"]
      }
    })
  });
  expect(r.status).toBe(200);
  return account!.id;
}
async function seedCachedEvents(
  accountId: string,
  rows: Array<{
    title: string;
    startsAt: string;
    endsAt: string;
    externalId: string;
    moss?: boolean;
  }>
): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const c=new CalendarRepository(); for(const row of ${JSON.stringify(rows)}) await c.upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:row.title,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),externalId:row.externalId,externalMetadata:row.moss?{jarvisCreated:true}:{}});});}finally{await runner.destroy();} console.log("seeded T22 calendar rows");})();`;
  const r = await execFileAsync(
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
  console.log(`[T22 calendar fixture] ${r.stdout.trim()}`);
}
async function setPolicy(page: Page, mode: string): Promise<void> {
  const r = await json(page, "/api/calendar/briefing-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeBlockMode: mode })
  });
  expect(r.status).toBe(200);
}
async function mirrorPlaced(
  planId: string,
  entries: Array<{ blockId: string; expectedPending: unknown; startsAt: string; ref: string }>
): Promise<void> {
  const script = `import { DayPlanRepository } from "/app/packages/calendar/src/day-plan-repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new DayPlanRepository(); for(const entry of ${JSON.stringify(entries)}) await repo.mirrorAppliedBlock(db,{planId:${JSON.stringify(planId)},blockId:entry.blockId,expectedPending:entry.expectedPending,actualPlacement:{startsAt:entry.startsAt,durationMinutes:30,calendarEventRef:entry.ref}});});}finally{await runner.destroy();}})();`;
  await execFileAsync(
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
}

async function createPlan(
  page: Page,
  timeZone: string
): Promise<{ planId: string; blocks: Array<{ id: string; pendingChange: unknown }> }> {
  const tA = await createTask(page, "UAT2786 write the draft");
  const tB = await createTask(page, "UAT2786 prepare the review");
  const tC = await createTask(page, "UAT2786 follow up");
  const tD = await createTask(page, "UAT2786 prepare the notes");
  const created = await json(page, "/api/calendar/day-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: SERVER_DAY, timeZone })
  });
  expect(created.status).toBe(200);
  const add = (time: string) => ({
    kind: "add",
    startsAt: localIso(SERVER_DAY, time),
    durationMinutes: 30
  });
  const draft = await json(page, `/api/calendar/day-plans/${created.body.plan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: SERVER_DAY,
      timeZone,
      expectedRevision: created.body.plan.revision,
      blocks: [
        { kind: "focus", taskId: tA, title: null, pendingChange: add("10:00") },
        { kind: "prep", taskId: tB, title: null, pendingChange: add("12:30") },
        { kind: "focus", taskId: tC, title: null, pendingChange: add("15:00") },
        { kind: "prep", taskId: tD, title: null, pendingChange: add("16:00") }
      ]
    })
  });
  expect(draft.status).toBe(200);
  return { planId: created.body.plan.id as string, blocks: draft.body.plan.blocks };
}

function row(page: Page, title: string): Locator {
  return page.locator("#schedule .jds-task", { hasText: title });
}

test("Today task blocks show Flexible, Proposed and the event reason", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  const accountId = await armCalendar(page);
  await seedCachedEvents(accountId, [
    // Moss-created events touching a prep block's end must never be named as its meeting.
    {
      title: "UAT2786 moss hold",
      startsAt: localIso(SERVER_DAY, "13:00"),
      endsAt: localIso(SERVER_DAY, "13:30"),
      externalId: "uat2786-moss-a",
      moss: true
    },
    {
      title: "UAT2786 moss only",
      startsAt: localIso(SERVER_DAY, "16:30"),
      endsAt: localIso(SERVER_DAY, "17:00"),
      externalId: "uat2786-moss-b",
      moss: true
    },
    {
      title: "UAT2786 project review",
      startsAt: localIso(SERVER_DAY, "13:00"),
      endsAt: localIso(SERVER_DAY, "14:00"),
      externalId: "uat2786-review"
    }
  ]);
  await setPolicy(page, "suggest");
  const { planId, blocks } = await createPlan(page, timeZone);
  // Blocks 0 (focus) and 1 (prep) are committed to the calendar; blocks 2 and 3 stay suggestions.
  await mirrorPlaced(
    planId,
    blocks.slice(0, 2).map((b, i) => ({
      blockId: b.id,
      expectedPending: b.pendingChange,
      startsAt: localIso(SERVER_DAY, i === 0 ? "10:00" : "12:30"),
      ref: `uat2786-${i}`
    }))
  );

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseURL());
    await expect(page.locator("#schedule")).toBeVisible();

    const flexible = row(page, "UAT2786 write the draft");
    await expect(flexible).toContainText("Flexible");
    await expect(flexible).not.toContainText("For UAT2786");

    const prep = row(page, "UAT2786 prepare the review");
    await expect(prep).toContainText("For UAT2786 project review at 1:00pm");
    await expect(prep).toContainText("Flexible");

    const proposed = row(page, "UAT2786 follow up");
    await expect(proposed).toContainText("Proposed");
    await expect(proposed).not.toContainText("Change pending");
    await expect(proposed).not.toContainText("Flexible");
    await expect(proposed).not.toContainText("For UAT2786");

    const mossOnly = row(page, "UAT2786 prepare the notes");
    await expect(mossOnly).toBeVisible();
    await expect(mossOnly).not.toContainText("For UAT2786");

    await expect(page.locator("#schedule")).not.toContainText("Change pending");
    await page.locator("#schedule").screenshot({ path: `/tmp/2786-uat-${width}.png` });
  }
});
