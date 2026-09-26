import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page, type Route } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// P9 live proof: persisted connector/plan inputs, a persisted failed run, one
// narrowly injected retry outage, then recovery through the real retry endpoint.
export const uatLevel = {
  level: "multi-user",
  without: [],
  withBriefingWriterFixture: true
} as const;

const TZ = "America/Los_Angeles";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
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

async function armGoogleSources(page: Page): Promise<string> {
  const accounts = await json(page, "/api/connectors/accounts");
  expect(accounts.status).toBe(200);
  const account = (accounts.body.accounts as Array<{ id: string; providerId: string }>).find(
    (candidate) => candidate.providerId === "google"
  );
  expect(account, "UAT seed must expose a Google account").toBeTruthy();
  const patched = await json(page, `/api/connectors/accounts/${account!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenPayload: {
        kind: "google-oauth",
        clientId: "p9-client",
        clientSecret: "p9-secret",
        accessToken: "p9-access",
        refreshToken: "p9-refresh",
        tokenExpiry: "2099-01-01T00:00:00.000Z",
        grantedScopes: [CALENDAR_SCOPE, GMAIL_SCOPE]
      }
    })
  });
  expect(patched.status).toBe(200);
  return account!.id;
}

async function seedEmailSyncAt(accountId: string, asOf: string): Promise<void> {
  const script = `import { ConnectorsRepository } from "/app/packages/connectors/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new ConnectorsRepository(); await repo.markSyncFinished(db,${JSON.stringify(accountId)},{finishedAt:new Date(${JSON.stringify(asOf)}),status:"success",error:null,counts:{emailUpserted:0}});});}finally{await runner.destroy();} console.log(JSON.stringify({source:"persisted connector account",accountId:${JSON.stringify(accountId)},gmailScope:${JSON.stringify(GMAIL_SCOPE)},lastSyncFinishedAt:${JSON.stringify(asOf)}}));})();`;
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
  console.log(`[P9 persisted email fixture] ${r.stdout.trim()}`);
}

async function seedCalendarEvent(
  accountId: string,
  input: { title: string; startsAt: string; endsAt: string }
): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{await new CalendarRepository().upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:${JSON.stringify(input.title)},startsAt:new Date(${JSON.stringify(input.startsAt)}),endsAt:new Date(${JSON.stringify(input.endsAt)}),externalId:"p9-live-proof"});});}finally{await runner.destroy();} console.log(JSON.stringify({source:"persisted calendar cache",title:${JSON.stringify(input.title)},startsAt:${JSON.stringify(input.startsAt)}}));})();`;
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
  console.log(`[P9 persisted calendar fixture] ${r.stdout.trim()}`);
}

async function createTask(page: Page, title: string): Promise<string> {
  const response = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt: null })
  });
  expect(response.status).toBe(201);
  return response.body.task.id as string;
}

async function createDayPlan(page: Page, date: string, timeZone: string, taskId: string) {
  const created = await json(page, "/api/calendar/day-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, timeZone })
  });
  expect(created.status).toBe(200);
  const block = {
    kind: "focus",
    taskId,
    title: null,
    pendingChange: {
      kind: "add",
      startsAt: localIso(date, "10:00"),
      durationMinutes: 30
    }
  };
  const draft = await json(page, `/api/calendar/day-plans/${created.body.plan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date,
      timeZone,
      expectedRevision: created.body.plan.revision,
      blocks: [block]
    })
  });
  expect(draft.status).toBe(200);
  return created.body.plan.id as string;
}

async function createMorningDefinition(page: Page): Promise<string> {
  const response = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "P9 degraded-source live proof",
      briefingType: "morning",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "07:00", timezone: TZ },
      selectedToolNames: ["tasks.list", "calendar.listVisibleEvents", "email.listVisibleMessages"]
    })
  });
  expect(response.status).toBe(201);
  return response.body.definition.id as string;
}

async function seedFailedRun(definitionId: string): Promise<string> {
  const script = `import { randomUUID } from "node:crypto"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{const row=await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>db.db.insertInto("app.briefing_runs").values({id:randomUUID(),definition_id:${JSON.stringify(definitionId)},owner_user_id:${JSON.stringify(UAT_ADMIN_ID)},status:"failed",run_kind:"manual",briefing_type:"morning",summary_text:"The morning briefing could not be prepared.",source_metadata:{},created_at:new Date()}).returning(["id","status","created_at"]).executeTakeFirstOrThrow()); console.log(JSON.stringify({source:"persisted briefing run",...row}));}finally{await runner.destroy();}})();`;
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
  const row = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
    id?: string;
    status?: string;
  };
  expect(row.id).toBeTruthy();
  expect(row.status).toBe("failed");
  console.log(`[P9 persisted failed-run fixture] ${r.stdout.trim()}`);
  return row.id!;
}

test("P9 degraded briefing source attribution and retry recovery through Today", async ({
  page
}) => {
  test.setTimeout(600_000);
  await page.clock.setFixedTime(new Date(localIso(SERVER_DAY, "08:00")));
  await signIn(page);

  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  expect(timeZone).toBe(TZ);

  const accountId = await armGoogleSources(page);
  const emailAsOf = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  await seedEmailSyncAt(accountId, emailAsOf);
  const taskId = await createTask(page, "P9 live proof task");
  const planId = await createDayPlan(page, SERVER_DAY, timeZone, taskId);
  await seedCalendarEvent(accountId, {
    title: "P9 live proof calendar event",
    startsAt: localIso(SERVER_DAY, "13:00"),
    endsAt: localIso(SERVER_DAY, "13:30")
  });

  const planRead = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(planRead.status).toBe(200);
  expect(planRead.body.plan.id).toBe(planId);
  expect(planRead.body.plan.eveningIntent).toBeNull();
  console.log(
    `[P9 persisted plan fixture] ${JSON.stringify({ planId, date: SERVER_DAY, eveningIntent: planRead.body.plan.eveningIntent })}`
  );

  const definitionId = await createMorningDefinition(page);
  const failedRunId = await seedFailedRun(definitionId);

  await page.goto("/today");
  const opener = page.getByRole("button", { name: "Read the full morning briefing" });
  await expect(opener).toBeVisible();
  await opener.click();
  const reader = page.getByRole("dialog");
  await expect(reader).toBeVisible();
  await expect(reader).toContainText("Your morning briefing isn't available.");
  const retryButton = reader.getByRole("button", { name: "Try again" });
  await expect(retryButton).toBeEnabled();

  const retryPath = `/api/briefings/definitions/${definitionId}/run`;
  const retryEvidence: string[] = [];
  let injectOneFailure = true;
  const injectRetryFailure = async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    if (injectOneFailure) {
      injectOneFailure = false;
      retryEvidence.push("injected HTTP 503 on first retry POST");
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "P9 UAT retry fault" })
      });
      return;
    }
    retryEvidence.push("second retry POST forwarded to live UAT endpoint");
    await route.continue();
  };
  await page.route(`**${retryPath}`, injectRetryFailure);

  const firstRetry = page.waitForResponse(
    (response) => response.url().endsWith(retryPath) && response.request().method() === "POST"
  );
  await retryButton.click();
  expect((await firstRetry).status()).toBe(503);
  await expect(
    reader.getByRole("status").filter({ hasText: "The retry request couldn’t be confirmed." })
  ).toBeVisible();
  await expect(retryButton).toBeEnabled();
  expect(retryEvidence).toEqual(["injected HTTP 503 on first retry POST"]);
  console.log(`[P9 injected fault evidence] ${retryEvidence[0]}; failedRunId=${failedRunId}`);

  const recoveredRetry = page.waitForResponse(
    (response) => response.url().endsWith(retryPath) && response.request().method() === "POST"
  );
  await retryButton.click();
  const retryResponse = await recoveredRetry;
  expect(retryResponse.status()).toBe(202);
  const retryBody = (await retryResponse.json()) as { runId: string };
  expect(retryBody.runId).not.toBe(failedRunId);
  expect(retryEvidence).toEqual([
    "injected HTTP 503 on first retry POST",
    "second retry POST forwarded to live UAT endpoint"
  ]);
  console.log(
    `[P9 retry recovery evidence] ${JSON.stringify({ status: retryResponse.status(), runId: retryBody.runId, retryEvidence })}`
  );
  await page.unroute(`**${retryPath}`, injectRetryFailure);

  let succeeded = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const runs = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    expect(runs.status).toBe(200);
    const retryRun = (
      runs.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((run) => run.id === retryBody.runId);
    if (retryRun?.status === "succeeded" && retryRun.summaryText.trim() !== "") {
      succeeded = true;
      break;
    }
    if (retryRun?.status === "failed" || retryRun?.status === "blocked") {
      throw new Error(`Real retry reached ${retryRun.status} instead of succeeding`);
    }
    await page.waitForTimeout(1000);
  }
  expect(succeeded, "real retry run should succeed after the one injected outage").toBe(true);

  const detail = await json(
    page,
    `/api/briefings/definitions/${definitionId}/runs/${retryBody.runId}`
  );
  expect(detail.status).toBe(200);
  expect(detail.body.state).toBe("ready");
  const run = detail.body.run as {
    sourceMetadata: {
      taskCount: number;
      calendarEventCount: number;
      sourceTimestamps: {
        capturedAt: string;
        sources: Array<{ source: string; freshnessKind: string; asOf: string | null }>;
      };
    };
    structuredPayload: { planContext: { eveningIntent: unknown } | null };
  };
  expect(run.sourceMetadata.taskCount).toBeGreaterThan(0);
  expect(run.sourceMetadata.calendarEventCount).toBeGreaterThan(0);
  expect(run.structuredPayload.planContext?.eveningIntent).toBeNull();
  const emailFreshness = run.sourceMetadata.sourceTimestamps.sources.find(
    (source) => source.source === "email"
  );
  expect(emailFreshness).toMatchObject({ freshnessKind: "connector_sync", asOf: emailAsOf });
  expect(
    Date.parse(run.sourceMetadata.sourceTimestamps.capturedAt) - Date.parse(emailAsOf)
  ).toBeGreaterThan(60 * 60 * 1000);
  console.log(
    `[P9 persisted run evidence] ${JSON.stringify({ runId: retryBody.runId, taskCount: run.sourceMetadata.taskCount, calendarEventCount: run.sourceMetadata.calendarEventCount, eveningIntent: run.structuredPayload.planContext?.eveningIntent, emailAsOf: emailFreshness?.asOf, capturedAt: run.sourceMetadata.sourceTimestamps.capturedAt })}`
  );

  await expect(reader.locator(".brief-reader__plan-source")).toContainText(
    "No evening plan was available for this briefing. Moss used today’s available sources, including tasks and calendar."
  );
  const emailNotice = reader.locator(".brief-reader__email-delay");
  await expect(emailNotice).toContainText("Email hasn’t updated since");
  await expect(emailNotice).toContainText("There may be newer replies this briefing hasn’t seen.");
  await expect(emailNotice.locator("time")).toHaveAttribute("datetime", emailAsOf);
  await expect(reader.getByRole("status")).not.toContainText(
    "The retry request couldn’t be confirmed."
  );
  console.log(
    "[P9 browser assertions] persisted delayed-email date/time and no-evening attribution are visible in the real Today reader; the first injected retry error cleared after the real retry succeeded."
  );
});
