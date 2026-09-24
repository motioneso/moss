import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_ID,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

// T22 assembled morning-to-evening acceptance for #2453. Assembled from the
// T18 (review/apply/move), T19 (Accept All), T20 (evening dialog) and T21
// (chat seed, cross-day handoff) boundary probes; not rewritten. Two tests:
// the daytime journey on the real clock, and the evening-to-morning handoff
// on a fixed 20:30 browser clock with the server day unchanged. The chat tool
// itself is proven live by the HTTP leg (workspace t22-real-http-boundary);
// here the chat drawer is opened and its seed request asserted.
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
function addDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
const PLAN_DAY = addDay(SERVER_DAY);
const EVENING_NOW = new Date(localIso(SERVER_DAY, "20:30"));

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
  const menu = page.locator(".jds-usermenu__trigger");
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
  rows: Array<{ title: string; startsAt: string; endsAt: string; externalId: string }>
): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const c=new CalendarRepository(); for(const row of ${JSON.stringify(rows)}) await c.upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:row.title,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),externalId:row.externalId});});}finally{await runner.destroy();} console.log("seeded T22 calendar rows");})();`;
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
async function createBriefingRun(
  page: Page,
  briefingType: "morning" | "evening",
  title: string,
  toolNames: string[]
): Promise<{ definitionId: string; runId: string }> {
  const definition = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      briefingType,
      cadence: "manual",
      enabled: true,
      scheduleMetadata: {
        targetTime: briefingType === "morning" ? "07:00" : "18:00",
        timezone: TZ
      },
      selectedToolNames: toolNames
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
  for (let i = 0; i < 60; i++) {
    const listed = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    expect(listed.status).toBe(200);
    const run = (
      listed.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((x) => x.id === runId);
    if (run && (run.summaryText.trim() || ["blocked", "failed"].includes(run.status))) {
      expect(run.status).toBe("succeeded");
      expect(run.summaryText.trim()).not.toBe("");
      return { definitionId, runId };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("T22 briefing run did not reach a populated terminal state");
}
async function checkLayout(page: Page, width: number): Promise<void> {
  const evidence = await page.evaluate(() => {
    const offenders = [...document.querySelectorAll<HTMLElement>("*")].flatMap((el) => {
      const r = el.getBoundingClientRect();
      return el.scrollWidth > el.clientWidth + 1 || r.left < -1 || r.right > innerWidth + 1
        ? [
            {
              tag: el.tagName.toLowerCase(),
              className: String(el.className).slice(0, 80),
              x: Math.round(r.x),
              width: Math.round(r.width)
            }
          ]
        : [];
    });
    return {
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      },
      offenders: offenders.slice(0, 12)
    };
  });
  expect(
    evidence.document,
    `layout offenders at ${width}px: ${JSON.stringify(evidence.offenders)}`
  ).toEqual({ scrollWidth: width, clientWidth: width });
}

async function createDayPlan(
  page: Page,
  date: string,
  timeZone: string,
  taskIds: string[]
): Promise<string> {
  const created = await json(page, "/api/calendar/day-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, timeZone })
  });
  expect(created.status).toBe(200);
  const blocks = taskIds.map((taskId, i) => ({
    kind: "focus",
    taskId,
    title: null,
    pendingChange: {
      kind: "add",
      startsAt: localIso(date, `${10 + i}:00`),
      durationMinutes: 30
    }
  }));
  const draft = await json(page, `/api/calendar/day-plans/${created.body.plan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, timeZone, expectedRevision: created.body.plan.revision, blocks })
  });
  expect(draft.status).toBe(200);
  return created.body.plan.id as string;
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

async function mirrorFirstBlock(page: Page, date: string, timeZone: string): Promise<void> {
  const r = await json(
    page,
    `/api/calendar/day-plan?date=${date}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(r.status).toBe(200);
  const planId = r.body.plan.id as string;
  const block = r.body.plan.blocks[0];
  const script = `import { DayPlanRepository } from "/app/packages/calendar/src/day-plan-repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new DayPlanRepository(); const plan=await repo.getById(db,${JSON.stringify(planId)}); const b=plan?.blocks.find((x)=>x.id===${JSON.stringify(block.id)}); if(!b?.pendingChange||b.pendingChange.kind!=="add") throw new Error("missing T22 saved block"); await repo.mirrorAppliedBlock(db,{planId:${JSON.stringify(planId)},blockId:${JSON.stringify(block.id)},expectedPending:b.pendingChange,actualPlacement:{startsAt:b.pendingChange.startsAt,durationMinutes:b.pendingChange.durationMinutes,calendarEventRef:"t22-existing"}});});}finally{await runner.destroy();}})();`;
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

test("T22 assembled daytime journey: briefing, review, Accept All, policy", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  const accountId = await armCalendar(page);
  await seedCachedEvents(accountId, [
    {
      title: "T22 standup",
      startsAt: localIso(SERVER_DAY, "09:00"),
      endsAt: localIso(SERVER_DAY, "09:30"),
      externalId: "t22-standup"
    },
    {
      title: "T22 planning",
      startsAt: localIso(PLAN_DAY, "14:00"),
      endsAt: localIso(PLAN_DAY, "15:00"),
      externalId: "t22-planning"
    }
  ]);
  await setPolicy(page, "suggest");
  const taskA = await createTask(page, "T22 assemble report", localIso(SERVER_DAY, "17:00"));
  const taskB = await createTask(page, "T22 call vendor");
  const taskC = await createTask(page, "T22 file notes");
  const planId = await createDayPlan(page, SERVER_DAY, timeZone, [taskA, taskB, taskC]);
  await mirrorFirstBlock(page, SERVER_DAY, timeZone);
  // News ships a JSON binding in UAT by default, so the run carries the
  // source/material links the reader assertions need.
  await createBriefingRun(page, "morning", "T22 morning", [
    "tasks.list",
    "calendar.listVisibleEvents",
    "news.topHeadlinesToday"
  ]);

  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/calendar\//.test(request.url())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.goto("/today");
  await expect(page.getByText("T22 assemble report").first()).toBeVisible();
  await expect(page.getByText("T22 standup").first()).toBeVisible();
  // 720 stands in for 200% zoom at desktop widths, per the existing e2e row.
  for (const width of [320, 375, 720, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, width);
  }
  const readerOpener = page.getByRole("button", { name: "Read the full morning briefing" });
  await expect(readerOpener).toBeVisible();
  await readerOpener.click();
  const reader = page.getByRole("dialog");
  await expect(reader).toBeVisible();
  await expect(reader).toContainText(/S+/);
  // News stories hydrate after the dialog opens, so wait for the first
  // link instead of counting once.
  const links = reader.getByRole("link");
  await expect(links.first()).toBeVisible();
  expect(await links.count()).toBeGreaterThan(0);
  expect(await links.first().getAttribute("href")).toBeTruthy();
  expect(writes.filter((w) => !w.includes("briefing-settings"))).toEqual([]);
  await expect(reader.getByRole("button", { name: "Accept all time blocks" })).toBeVisible();

  // The reader is modal (scrim plus inert app root), so the review opens
  // from its own footer button, which swaps the dialogs by design.
  await reader.getByRole("button", { name: "Review task blocks" }).click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByRole("heading", { name: "Your day, prepared." })).toBeFocused();
  await dialog.getByLabel("T22 call vendor: placement").selectOption("add");
  await dialog.getByLabel("T22 call vendor: start time").fill("11:30");
  await expect(dialog).toContainText("Add T22 call vendor at 11:30");
  await expect(dialog.getByRole("button", { name: "Save changes" })).toBeEnabled();
  const applyResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/calendar/day-plans/") && response.url().endsWith("/apply")
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  expect((await applyResponse).status()).toBe(200);
  await expect(dialog).toContainText(/Applied|pending/);

  // Confirmed move of the committed block to a second known time. Fake
  // tokens cannot place anything, so the apply outcome is recorded here and
  // the provider callback is simulated below, as the T20 probe does.
  await dialog.getByLabel("T22 assemble report: placement").selectOption("move");
  await dialog.getByLabel("T22 assemble report: start time").fill("15:00");
  await expect(dialog).toContainText("Move T22 assemble report");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const confirm = dialog.locator("section.plan-review__confirm");
  await expect(dialog).toContainText(/Applied|pending|Confirm calendar changes/);
  if ((await confirm.count()) > 0 && (await confirm.isVisible())) {
    await expect(confirm).toContainText("Confirm calendar changes");
    await confirm.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toContainText(/Applied|pending/);
  }
  await dialog.getByRole("button", { name: "Back to Today" }).click();

  const preMirror = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const movedAt = localIso(SERVER_DAY, "15:00");
  const addedAt = localIso(SERVER_DAY, "11:30");
  const preBlocks = preMirror.body.plan.blocks as Array<{
    id: string;
    taskId: string | null;
    pendingChange: unknown;
  }>;
  await mirrorPlaced(planId, [
    {
      blockId: preBlocks.find((b) => b.taskId === taskB)!.id,
      expectedPending: preBlocks.find((b) => b.taskId === taskB)!.pendingChange,
      startsAt: addedAt,
      ref: "t22-sim-added"
    },
    {
      blockId: preBlocks.find((b) => b.taskId === taskA)!.id,
      expectedPending: preBlocks.find((b) => b.taskId === taskA)!.pendingChange,
      startsAt: movedAt,
      ref: "t22-sim-moved"
    }
  ]);

  await page.reload();

  // 1. Today shows the added time and the moved new time.
  const schedule = page.locator("#schedule");
  await expect(schedule).toContainText("T22 call vendor");
  await expect(schedule).toContainText("11:30");
  await expect(schedule).toContainText("T22 assemble report");
  await expect(schedule).toContainText("3:00");

  // 2. Task detail opens for the added block. It renders no block time on
  // this base, so the map records that as a gap instead of asserting it.
  await page
    .getByRole("button", { name: /T22 call vendor/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // 3. Reader plan rows read the placed and pending states with times.
  await readerOpener.click();
  const reread = page.getByRole("dialog");
  await expect(reread).toContainText("On the calendar");
  await expect(reread).toContainText("T22 call vendor");
  await expect(reread).toContainText("11:30");
  // The reader words pending blocks as "Change pending"; the "Proposed,
  // not on the calendar yet" copy lives in the review dialog (step 4).
  await expect(reread).toContainText("Change pending");

  // 4. Review from the reader footer agrees; close returns focus.
  await reread.getByRole("button", { name: "Review task blocks" }).click();
  const review = page.getByRole("dialog");
  await expect(page.getByRole("heading", { name: "Your day, prepared." })).toBeVisible();
  await expect(review).toContainText("On the calendar");
  // The reader-hosted review words pending blocks as "Change pending".
  await expect(review).toContainText("Change pending");
  await review.getByRole("button", { name: "Back to Today" }).click();
  await expect(readerOpener).toBeFocused();

  // 5. The read route agrees: unique tasks, moved placement, left pending.
  const agreed = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(agreed.status).toBe(200);
  const agreedBlocks = agreed.body.plan.blocks as Array<{
    taskId: string | null;
    pendingChange: unknown;
    actualPlacement: { startsAt: string | null } | null;
  }>;
  const agreedTasks = agreedBlocks.map((b) => b.taskId).filter(Boolean);
  expect(new Set(agreedTasks).size).toBe(agreedTasks.length);
  expect(agreedBlocks.find((b) => b.taskId === taskA)?.actualPlacement?.startsAt).toBe(movedAt);
  expect(agreedBlocks.find((b) => b.taskId === taskB)?.actualPlacement?.startsAt).toBe(addedAt);
  expect(agreedBlocks.find((b) => b.taskId === taskC)?.pendingChange).toBeTruthy();

  await readerOpener.click();
  await page.getByRole("dialog").getByRole("button", { name: "Accept all time blocks" }).click();
  await expect(page.getByRole("dialog")).toContainText(/Accept|added|Nothing was added/);
  await page.getByRole("dialog").getByRole("button", { name: "Back to Today" }).click();

  await setPolicy(page, "auto");
  const auto = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const committed = (
    auto.body.plan.blocks as Array<{ actualPlacement: { startsAt: string | null } | null }>
  ).filter((b) => b.actualPlacement?.startsAt);
  expect(committed.length).toBeGreaterThan(0);
  await setPolicy(page, "suggest");
  const back = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const stillCommitted = (
    back.body.plan.blocks as Array<{ actualPlacement: { startsAt: string | null } | null }>
  ).filter((b) => b.actualPlacement?.startsAt);
  expect(stillCommitted.length).toBe(committed.length);

  const keyboardOpener = page.getByRole("button", { name: "Review task blocks" }).first();
  await keyboardOpener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your day, prepared." })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Back to Today" }).click();
  await expect(keyboardOpener).toBeFocused();
  const finalRead = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(finalRead.body.plan.id).toBe(planId);
});

test("T22 assembled evening-to-morning handoff plus actor isolation", async ({ page, browser }) => {
  test.setTimeout(600_000);
  await page.clock.setFixedTime(EVENING_NOW);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  expect(timeZone).toBe(TZ);
  await setPolicy(page, "suggest");
  const taskId = await createTask(page, "T22 evening follow-up");
  const correctionId = await createTask(page, "T22 completed reflection");
  const donePatch = await json(page, `/api/tasks/${correctionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "done" })
  });
  expect(donePatch.status).toBe(200);
  // Recap rows come from today's plan blocks, so both the open task and
  // the completed task join today's plan for their correction fields to
  // render. The save carries the existing blocks forward: dropping a
  // recorded placement without a pending removal is refused, by design.
  const carry = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const keep = (
    carry.body.plan.blocks as Array<{
      id: string;
      kind: string;
      taskId: string | null;
      title: string | null;
      pendingChange: unknown;
    }>
  ).map((b) => ({
    id: b.id,
    kind: b.kind,
    taskId: b.taskId,
    title: b.title,
    pendingChange: b.pendingChange
  }));
  const carried = await json(page, `/api/calendar/day-plans/${carry.body.plan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: SERVER_DAY,
      timeZone,
      expectedRevision: carry.body.plan.revision,
      blocks: [
        ...keep,
        {
          kind: "focus",
          taskId,
          title: null,
          pendingChange: {
            kind: "add",
            startsAt: localIso(SERVER_DAY, "09:00"),
            durationMinutes: 30
          }
        },
        {
          kind: "focus",
          taskId: correctionId,
          title: null,
          pendingChange: {
            kind: "add",
            startsAt: localIso(SERVER_DAY, "10:00"),
            durationMinutes: 30
          }
        }
      ]
    })
  });
  expect(carried.status).toBe(200);
  const evening = await createBriefingRun(page, "evening", "T22 evening", ["tasks.list"]);
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") {
      requests.push({
        method: request.method(),
        url: request.url(),
        body: request.postDataJSON() ?? undefined
      });
    }
  });

  await page.goto("/today");
  await expect(page.getByRole("button", { name: "Plan tomorrow" })).toBeVisible();
  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const planDialog = page.getByRole("dialog");
  await expect(planDialog).toBeVisible();
  await expect(planDialog.locator(".evening-plan__prose")).toHaveText(/S+/);
  const correction = planDialog.getByLabel("T22 evening follow-up: correction");
  await expect(correction).toBeVisible();
  const doneCorrection = planDialog.getByLabel("T22 completed reflection: correction");
  await doneCorrection.fill("meeting happened, follow-up not sent");
  await doneCorrection
    .locator("xpath=ancestor::li[1]")
    .getByRole("button", { name: "Add" })
    .click();
  await planDialog
    .getByRole("radiogroup", { name: "T22 evening follow-up: plan" })
    .getByLabel("Tomorrow")
    .click();
  await planDialog
    .getByRole("radiogroup", { name: "Day capacity" })
    .getByLabel("Lighter day")
    .click();
  await planDialog.getByLabel("The one thing that matters").selectOption(taskId);
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await planDialog.getByRole("button", { name: "Save tomorrow's plan" }).click();
  await expect(planDialog).toContainText("Saved. The blocks are proposed for the morning.");
  const creates = requests.filter(
    (r) => r.method === "POST" && r.url.endsWith("/api/calendar/day-plans")
  );
  expect(creates).toHaveLength(1);
  expect((creates[0]?.body as { sourceRunId?: string } | undefined)?.sourceRunId).toBe(
    evening.runId
  );
  const saved = await json(
    page,
    `/api/calendar/day-plan?date=${PLAN_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(saved.status).toBe(200);
  expect(saved.body.plan.sourceRunId).toBe(evening.runId);
  const planId = saved.body.plan.id as string;
  await planDialog.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.getByRole("button", { name: "Plan tomorrow" })).toBeFocused();

  await page.locator("button.ev-tomorrow__chat").filter({ hasText: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  expect(
    requests.filter((r) => r.method === "POST" && r.url.includes("/api/chat/evening-interview"))
  ).toHaveLength(1);
  await drawer.getByRole("button", { name: "Close chat" }).click();

  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const reopened = page.getByRole("dialog");
  await expect(reopened).toContainText("meeting happened, follow-up not sent");
  await expect(reopened.getByLabel("The one thing that matters")).toHaveValue(taskId);
  await expect(
    reopened.getByRole("radiogroup", { name: "Day capacity" }).getByLabel("Lighter day")
  ).toBeChecked();
  await reopened.getByRole("button", { name: "Leave for now" }).click();

  const morning = await createBriefingRun(page, "morning", "T22 next morning", [
    "tasks.list",
    "calendar.listVisibleEvents"
  ]);
  const listed = await json(page, `/api/briefings/definitions/${morning.definitionId}/runs`);
  const run = (listed.body.runs as Array<{ id: string; summaryText: string }>).find(
    (x) => x.id === morning.runId
  );
  expect(run?.summaryText ?? "").toContain("T22 evening follow-up");

  // The cited event was never seeded, so the fresh run must report it lost.
  // Committed placement goes straight into storage; drafts never accept it.
  const mirrorRead = await json(
    page,
    `/api/calendar/day-plan?date=${PLAN_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const mirrorBlock = mirrorRead.body.plan.blocks[0];
  const mirrorScript = `import { DayPlanRepository } from "/app/packages/calendar/src/day-plan-repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new DayPlanRepository(); await repo.mirrorAppliedBlock(db,{planId:${JSON.stringify(planId)},blockId:${JSON.stringify(mirrorBlock.id)},expectedPending:${JSON.stringify(mirrorBlock.pendingChange)},actualPlacement:{startsAt:${JSON.stringify(mirrorBlock.pendingChange.startsAt)},durationMinutes:${JSON.stringify(mirrorBlock.pendingChange.durationMinutes)},calendarEventRef:"t22-vanished"}});});}finally{await runner.destroy();}})();`;
  await execFileAsync(
    "docker",
    buildUatComposeArgs(uatProject(), [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "--eval",
      mirrorScript
    ]),
    { maxBuffer: 1_000_000 }
  );
  const fresh = await createBriefingRun(page, "morning", "T22 next morning fresh", [
    "tasks.list",
    "calendar.listVisibleEvents"
  ]);
  const freshListed = await json(page, `/api/briefings/definitions/${fresh.definitionId}/runs`);
  const freshRun = (freshListed.body.runs as Array<{ id: string; summaryText: string }>).find(
    (x) => x.id === fresh.runId
  );
  expect(freshRun?.summaryText ?? "").toContain("Overnight change");
  expect(freshRun?.summaryText ?? "").toContain("lost its calendar event");
  expect(freshRun?.summaryText ?? "").toContain("review before accepting");
  // The run pins the browser at 20:30, when /today shows the evening review
  // instead of the morning section by design. Rewind to the morning so the
  // fresh run's reader can open; the run itself is already recorded.
  await page.clock.setFixedTime(new Date(localIso(SERVER_DAY, "08:00")));
  await page.goto("/today");
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const nextReader = page.getByRole("dialog");
  await expect(nextReader).toContainText("SAVED DAY PLAN");
  await expect(nextReader).toContainText("Overnight change");
  await nextReader.getByRole("button", { name: "Back to Today" }).click();
  const kept = await json(
    page,
    `/api/calendar/day-plan?date=${PLAN_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  const keptBlock = (
    kept.body.plan.blocks as Array<{ actualPlacement: { startsAt: string | null } | null }>
  ).find((b) => b.actualPlacement?.startsAt);
  expect(keptBlock?.actualPlacement?.startsAt).toBeTruthy();

  const bContext = await browser.newContext({ baseURL: baseURL() });
  const b = await bContext.newPage();
  await b.clock.setFixedTime(EVENING_NOW);
  await signIn(b, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  const foreign = await json(
    b,
    `/api/calendar/day-plan?date=${PLAN_DAY}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(foreign.status).toBe(200);
  expect(foreign.body.plan).toBeNull();
  const foreignDraft = await json(b, `/api/calendar/day-plans/${planId}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: PLAN_DAY,
      timeZone,
      expectedRevision: 1,
      eveningIntent: { notes: "stolen" }
    })
  });
  expect(foreignDraft.status).toBe(404);
  const bMorning = await createBriefingRun(b, "morning", "T22 B morning", ["tasks.list"]);
  const bListed = await json(b, `/api/briefings/definitions/${bMorning.definitionId}/runs`);
  const bRun = (bListed.body.runs as Array<{ id: string; summaryText: string }>).find(
    (x) => x.id === bMorning.runId
  );
  expect(bRun?.summaryText ?? "").not.toContain("T22 evening follow-up");
  await b.close();
  await bContext.close();
});
