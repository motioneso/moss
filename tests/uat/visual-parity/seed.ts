// tests/uat/visual-parity/seed.ts
//
// VP-P0 shared populated seed, driven by tests/fixtures/visual-parity/seed-manifest.json.
// Tasks, meetings and events are created through the API; news and sports arrive
// through the existing fixture seam; weather location is set by API, forecast live.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";

const execFileAsync = promisify(execFile);
export const TZ = "America/Los_Angeles";
const HERE = dirname(fileURLToPath(import.meta.url));
export interface Manifest {
  [key: string]: unknown;
}
export function manifest(): Manifest {
  return JSON.parse(
    readFileSync(join(HERE, "..", "..", "fixtures", "visual-parity", "seed-manifest.json"), "utf8")
  );
}
export function localDay(date = new Date()): string {
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
export function addDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}
export function resolveStamp(day: string, stamp: string): string {
  const [d, t] = stamp.split("-") as [string, string];
  return localIso(d === "today" ? day : addDay(day), t);
}
function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT fixture target");
  return project;
}
export async function json(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { path, init }
  );
}
export async function createTask(
  page: Page,
  title: string,
  dueAt: string | null = null
): Promise<string> {
  const r = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt })
  });
  expect(r.status).toBe(201);
  return (r.body as { task: { id: string } }).task.id;
}
export async function armCalendar(page: Page): Promise<string> {
  const accounts = await json(page, "/api/connectors/accounts");
  expect(accounts.status).toBe(200);
  const account = (accounts.body.accounts as Array<{ id: string; providerId: string }>).find(
    (a) => a.providerId === "google"
  );
  expect(account).toBeTruthy();
  const r = await json(page, `/api/connectors/accounts/${account!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenPayload: {
        kind: "google-oauth",
        clientId: "vp-client",
        clientSecret: "vp-secret",
        accessToken: "vp-access",
        refreshToken: "vp-refresh",
        tokenExpiry: "2099-01-01T00:00:00.000Z",
        grantedScopes: ["https://www.googleapis.com/auth/calendar"]
      }
    })
  });
  expect(r.status).toBe(200);
  return account!.id;
}
export async function seedCachedEvents(
  page: Page,
  accountId: string,
  rows: Array<{ title: string; startsAt: string; endsAt: string; externalId: string }>
): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const c=new CalendarRepository(); for(const row of ${JSON.stringify(rows)}) await c.upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:row.title,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),externalId:row.externalId});});}finally{await runner.destroy();} console.log("seeded parity calendar rows");})();`;
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
  console.log(`[parity calendar] ${r.stdout.trim()}`);
}
export async function stabilizeSportsFollowOrder(): Promise<void> {
  const sql = `UPDATE app.sports_follows SET created_at = CASE
    WHEN competition_key = 'eng.1' AND team_key = 'ars' THEN '2026-09-01T12:00:00Z'::timestamptz
    WHEN competition_key = 'nba' THEN '2026-09-01T13:00:00Z'::timestamptz
    WHEN competition_key = 'nfl' THEN '2026-09-02T12:00:00Z'::timestamptz
    WHEN competition_key = 'eng.1' AND team_key IS NULL THEN '2026-09-03T12:00:00Z'::timestamptz
    ELSE created_at END
    WHERE owner_user_id = '${UAT_ADMIN_ID}';
  UPDATE app.sports_custom_sources SET created_at = CASE label
    WHEN 'Issue 1909 fixture feed' THEN '2026-09-04T12:00:00Z'::timestamptz
    WHEN 'FotMob assignment fixture' THEN '2026-09-04T13:00:00Z'::timestamptz
    WHEN 'BBC legacy feed' THEN '2026-09-04T14:00:00Z'::timestamptz
    WHEN 'FotMob legacy scrape' THEN '2026-09-04T15:00:00Z'::timestamptz
    WHEN 'Issue 1909 drift fixture' THEN '2026-09-04T16:00:00Z'::timestamptz
    ELSE created_at END
    WHERE owner_user_id = '${UAT_ADMIN_ID}';
  UPDATE app.sports_source_assignments AS assignment
  SET created_at = source.created_at + CASE
    WHEN follow.team_key = 'ars' THEN INTERVAL '1 second'
    WHEN follow.competition_key = 'nfl' THEN INTERVAL '2 seconds'
    ELSE INTERVAL '3 seconds' END
  FROM app.sports_custom_sources AS source, app.sports_follows AS follow
  WHERE assignment.source_id = source.id
    AND follow.id = assignment.follow_id
    AND assignment.owner_user_id = '${UAT_ADMIN_ID}'
    AND source.owner_user_id = '${UAT_ADMIN_ID}';`;
  await execFileAsync(
    "docker",
    buildUatComposeArgs(uatProject(), [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql
    ]),
    { maxBuffer: 1_000_000 }
  );
}
export async function disableSeededCustomSources(): Promise<void> {
  const sql = `UPDATE app.sports_custom_sources SET enabled = false WHERE owner_user_id = '${UAT_ADMIN_ID}';`;
  await execFileAsync(
    "docker",
    buildUatComposeArgs(uatProject(), [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql
    ]),
    { maxBuffer: 1_000_000 }
  );
}
export async function setPolicy(page: Page, mode: string): Promise<void> {
  const r = await json(page, "/api/calendar/briefing-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeBlockMode: mode })
  });
  expect(r.status).toBe(200);
}
export async function createBriefingRun(
  page: Page,
  briefingType: "morning" | "evening",
  title: string,
  toolNames: string[],
  stableCreatedAt: string
): Promise<void> {
  const d = await json(page, "/api/briefings/definitions", {
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
  expect(d.status).toBe(201);
  const id = (d.body as { definition: { id: string } }).definition.id;
  const run = await json(page, `/api/briefings/definitions/${id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  expect(run.status).toBe(202);
  const runId = (run.body as { runId: string }).runId;
  for (let i = 0; i < 90; i++) {
    const listed = await json(page, `/api/briefings/definitions/${id}/runs`);
    expect(listed.status).toBe(200);
    const found = (
      listed.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((x) => x.id === runId);
    if (found && (found.summaryText.trim() || ["blocked", "failed"].includes(found.status))) {
      expect(found.status).toBe("succeeded");
      expect(found.summaryText.trim()).not.toBe("");
      const sql = `UPDATE app.briefing_runs SET created_at = '${stableCreatedAt.replaceAll("'", "''")}'::timestamptz WHERE id = '${runId.replaceAll("'", "''")}';`;
      await execFileAsync(
        "docker",
        buildUatComposeArgs(uatProject(), [
          "exec",
          "-T",
          "postgres",
          "psql",
          "-U",
          "postgres",
          "-d",
          "jarv1s",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql
        ]),
        { maxBuffer: 1_000_000 }
      );
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("parity briefing run did not populate");
}
export async function createDayPlan(
  page: Page,
  day: string,
  timeZone: string,
  taskIds: string[]
): Promise<string> {
  const created = await json(page, "/api/calendar/day-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: day, timeZone })
  });
  expect(created.status).toBe(200);
  const blocks = taskIds.map((taskId, i) => ({
    kind: "focus",
    taskId,
    title: `Parity block ${i + 1}`,
    pendingChange: {
      kind: "add",
      startsAt: localIso(day, i ? "11:00" : "10:00"),
      durationMinutes: 30
    }
  }));
  const createdPlan = (created.body as { plan: { id: string; revision: number } }).plan;
  const draft = await json(page, `/api/calendar/day-plans/${createdPlan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: day,
      timeZone,
      expectedRevision: createdPlan.revision,
      blocks
    })
  });
  expect(draft.status).toBe(200);
  return createdPlan.id;
}
export async function mirrorBlock(
  page: Page,
  day: string,
  timeZone: string,
  index: number
): Promise<void> {
  const r = await json(
    page,
    `/api/calendar/day-plan?date=${day}&timeZone=${encodeURIComponent(timeZone)}`
  );
  expect(r.status).toBe(200);
  const dayPlan = (r.body as { plan: { id: string; blocks: Array<{ id: string }> } }).plan;
  const planId = dayPlan.id;
  const block = dayPlan.blocks[index] as { id: string };
  const script = `import { DayPlanRepository } from "/app/packages/calendar/src/day-plan-repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new DayPlanRepository(); const plan=await repo.getById(db,${JSON.stringify(planId)}); const block=plan?.blocks.find((b)=>b.id===${JSON.stringify(block.id)}); if(block?.pendingChange?.kind==="add") await repo.mirrorAppliedBlock(db,{planId:${JSON.stringify(planId)},blockId:${JSON.stringify(block.id)},expectedPending:block.pendingChange,actualPlacement:{startsAt:block.pendingChange.startsAt,durationMinutes:block.pendingChange.durationMinutes,calendarEventRef:"vp-existing"}});});}finally{await runner.destroy();}})();`;
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
export async function setWeatherLocation(page: Page, label: string): Promise<void> {
  const current = await json(page, "/api/me/weather-location");
  expect(current.status).toBe(200);
  void current;
  const location = { lat: 37.7749, lon: -122.4194, label };
  const r = await json(page, "/api/me/weather-location", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(location)
  });
  expect(r.status).toBe(200);
}

export async function forceChrome(page: Page): Promise<void> {
  await page.addInitScript({
    content:
      "localStorage.setItem('jarvis.theme:v1','light');localStorage.setItem('jarvis.nav:v1','expanded');"
  });
}
export async function closeDialogs(page: Page): Promise<void> {
  for (const name of ["Close briefing reader", "Close dialog"]) {
    const btn = page.getByRole("dialog").getByRole("button", { name });
    if ((await btn.count()) && (await btn.first().isVisible())) {
      await btn.first().click();
    }
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
export async function openToday(page: Page, clock: Date): Promise<void> {
  await page.clock.setFixedTime(clock);
  await page.goto("/today", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}
// The sticky topbar's bottom edge in viewport pixels at the live viewport.
// Measured, never a constant: the bar's 60 is a minimum with padding and a
// border above it, and it grows when the title wraps at narrow widths.
async function topbarBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    return bar ? bar.getBoundingClientRect().bottom : 0;
  });
}

// True when the target (or an ancestor below the scrolling container) is
// fixed to the viewport: scrolling cannot move it, and overlap with the bar
// is paint order, which this harness does not judge.
async function isViewportPinned(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      let node: Element | null = el;
      while (node) {
        if (getComputedStyle(node).position === "fixed") return true;
        node = node.parentElement;
      }
      return false;
    });
}

// Scrolls the target's own scrolling ancestor up by px. The page can scroll
// inside a container (chat docked at 721 wide and up), where a window scroll
// does nothing, so the nearest ancestor that actually scrolls takes it.
async function scrollAncestorUp(page: Page, selector: string, px: number): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el, px) => {
      // A container counts only if it actually scrolls: content taller than
      // the box is not enough (an overflow:visible wrapper never moves).
      // Probe each candidate by nudging it and checking the position stuck,
      // then put it back before scrolling for real.
      const scrolls = (box: Element): boolean => {
        const target = box as HTMLElement;
        const priorBehavior = target.style.scrollBehavior;
        target.style.scrollBehavior = "auto";
        try {
          const before = target.scrollTop;
          target.scrollTop = before + 1;
          if (target.scrollTop !== before) {
            target.scrollTop = before;
            return true;
          }
          target.scrollTop = before - 1;
          const moved = target.scrollTop !== before;
          target.scrollTop = before;
          return moved;
        } finally {
          target.style.scrollBehavior = priorBehavior;
        }
      };
      let node: Element | null = el;
      while (node) {
        const parent: Element | null = node.parentElement;
        if (!parent) break;
        if (parent.scrollHeight > parent.clientHeight + 1 && scrolls(parent)) {
          parent.scrollTop -= px;
          return;
        }
        node = parent;
      }
      const doc = document.scrollingElement;
      if (doc) doc.scrollTop -= px;
    }, px);
}

export async function scrollSectionTop(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.evaluate((el) => el.scrollIntoView(true));
  await page.waitForTimeout(300);
  if (await isViewportPinned(page, selector)) return;
  const width = page.viewportSize()?.width ?? 0;
  const measure = async () => {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`parity: ${selector} has no box to measure against the topbar`);
    const barBottom = await topbarBottom(page);
    return { barBottom, targetTop: box.y, overlap: barBottom - box.y };
  };
  let measured = await measure();
  if (measured.overlap > 0) {
    await scrollAncestorUp(page, selector, Math.ceil(measured.overlap));
    await page.waitForTimeout(300);
    measured = await measure();
  }
  if (measured.overlap > 0) {
    throw new Error(
      `parity: ${selector} still under the topbar after offset ` +
        `at ${width}px viewport (bar ${measured.barBottom}px, overlap ${measured.overlap}px)`
    );
  }
}
const STRIP = ["Reflect", "Open commitments", "Shape tomorrow", "Review"];
export async function ensurePlanning(page: Page, viewport: Viewport, step: number): Promise<void> {
  await closeDialogs(page);
  await page.setViewportSize({ width: viewport.w, height: viewport.h });
  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("navigation", { name: "Plan steps" })
    .getByRole("button", { name: new RegExp(`^(0[1-4] )?${STRIP[step]!}$`) })
    .click();
  await page.waitForTimeout(300);
}
export async function ensureReader(page: Page, viewport: Viewport, tab: 0 | 1): Promise<void> {
  await closeDialogs(page);
  await page.setViewportSize({ width: viewport.w, height: viewport.h });
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab").nth(tab).click();
  await page.waitForTimeout(300);
}

// Walk entry setup, moved here from the parity spec so entry ordering is
// directly testable: every case lays out and scrolls at its own viewport.
import { runSetupActions, statePrerequisites } from "./case-selection.js";
import { type MockupEntry, type Viewport } from "./mockups.js";

export interface ParityEvent {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
}
export interface ParityTask {
  readonly key: string;
  readonly title: string;
  readonly due: string | null;
  readonly status?: string;
}
export interface ParityManifest {
  readonly tasks: readonly ParityTask[];
  readonly meetings: readonly ParityEvent[];
  readonly events: readonly ParityEvent[];
  readonly todayPlanTasks: readonly string[];
  readonly tomorrowPlanTasks: readonly string[];
  readonly news: { readonly expectedHeadline: string };
  readonly weather: { readonly location: string };
}
export interface ScoreGame {
  readonly home?: { readonly sourceTeamId?: string };
  readonly away?: { readonly sourceTeamId?: string };
}
export async function localeTz(page: Page): Promise<string> {
  const locale = (await json(page, "/api/me/locale")).body as { locale: { timezone: string } };
  return locale.locale.timezone;
}
export async function overview(
  page: Page,
  path: string,
  key: string,
  ms: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await json(page, path);
    if (r.status === 200 && Array.isArray((r.body as Record<string, unknown>)[key])) {
      const rows = (r.body as Record<string, unknown>)[key] as readonly unknown[];
      if (rows.length > 0) return r.body as Record<string, unknown>;
    }
    await page.waitForTimeout(5000);
  }
  throw new Error(`parity: ${path} carried no ${key}`);
}
export async function populatedMorning(page: Page, m: ParityManifest): Promise<void> {
  const task0 = m.tasks[0];
  const meeting0 = m.meetings[0];
  if (!task0 || !meeting0) throw new Error("parity: manifest tasks/meetings empty");
  await expect(page.getByText(task0.title).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(meeting0.title).first()).toBeVisible({ timeout: 30000 });
  const sports = await overview(page, "/api/sports/overview", "scoreboard", 120000);
  const groups = sports["scoreboard"] as Array<{ readonly games: readonly ScoreGame[] }>;
  const games = groups.flatMap((g) => g.games);
  expect(games.some((g) => [g.home?.sourceTeamId, g.away?.sourceTeamId].includes("359"))).toBe(
    true
  );
  const news = await overview(page, "/api/news/overview", "topStories", 180000);
  await expect(page.locator(".jds-brief--news").first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator(".jds-brief--sports").first()).toBeVisible({ timeout: 60000 });
  const arsenalItem = page.getByRole("listitem").filter({ hasText: "Arsenal" }).first();
  await expect(arsenalItem).toBeVisible({ timeout: 60000 });
  await expect(page.locator("#weather")).toContainText(/\S/, { timeout: 60000 });
  console.log(
    `[parity] populated: timeline, weather, news lead "${((news["topStories"] as Array<{ title: string }>)[0] as { title: string }).title}", sports scores`
  );
}
export async function driveState(page: Page, state: string, viewport: Viewport): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (state.startsWith("today-")) {
    await closeDialogs(page).catch(() => undefined);
    await page.setViewportSize({ width: viewport.w, height: viewport.h });
    if (state === "today-morning-news") await scrollSectionTop(page, ".jds-brief--news");
    if (state === "today-morning-sports")
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
  } else if (state.startsWith("reader-")) {
    const tab = state.includes("-review") || state.includes("partial") ? 1 : 0;
    await ensureReader(page, viewport, tab as 0 | 1);
  } else if (state.startsWith("evening-step-")) {
    await ensurePlanning(page, viewport, Number(state.slice("evening-step-".length)));
  } else if (state === "evening-saved") {
    await expect(dialog).toBeVisible();
  }
}
export async function prepareSelectedEntry(
  page: Page,
  entry: MockupEntry,
  m: ParityManifest
): Promise<void> {
  // Size the viewport before any setup runs: every step below lays out and
  // scrolls, and doing that at the previous case's width leaves the case
  // photographed at a width it was never set up for. One unconditional call
  // covers both widths with no viewport-specific branch.
  await page.setViewportSize({ width: entry.viewport.w, height: entry.viewport.h });
  statePrerequisites(entry.state);
  const morning = new Date(localIso(localDay(), "08:00"));
  const evening = new Date(localIso(localDay(), "20:00"));
  const dialog = () => page.getByRole("dialog");
  // The recipe is performed action by action, in declared order: the recorded
  // dispatch is what the unit suite observes, so the plan cannot drift from
  // the browser behavior it describes.
  await runSetupActions(entry.state, {
    openTodayMorning: () => openToday(page, morning),
    openTodayEvening: () => openToday(page, evening),
    populatedMorning: () => populatedMorning(page, m),
    planningStep: async (step) => {
      if (step === 0) {
        await ensurePlanning(page, entry.viewport, 0);
        return;
      }
      const steps = dialog().getByRole("navigation", { name: "Plan steps" });
      if (step === 1) await steps.getByRole("button", { name: "Open commitments" }).click();
      else if (step === 2) await steps.getByRole("button", { name: "Shape tomorrow" }).click();
      else await steps.getByRole("button", { name: "Review" }).click();
    },
    // A save with no new intent change is rejected (400), and this walk saves
    // twice against one backend: re-picking an already-saved Tomorrow changes
    // nothing, so fall back to another real commitment decision instead.
    choiceTomorrow: async () => {
      const group = dialog().getByRole("radiogroup", {
        name: `${(m.tasks[2] as ParityTask).title}: plan`
      });
      const tomorrow = group.getByLabel("Tomorrow");
      if (await tomorrow.isChecked()) await group.getByLabel("Keep on the list").check();
      else await tomorrow.check();
    },
    planningSaved: () => dialog().getByRole("button", { name: "Save tomorrow's plan" }).click(),
    expectSavedText: () =>
      expect(dialog()).toContainText("Saved. The blocks are proposed for the morning."),
    closeDialogs: () => closeDialogs(page).then(() => undefined),
    expectTodayRoute: () => expect(page).toHaveURL(/\/today/),
    driveState: async () => {
      if (entry.state === "reader-partial-review")
        await mirrorBlock(page, localDay(), await localeTz(page), 0);
      if (entry.state.startsWith("reader-automatic"))
        await mirrorBlock(page, localDay(), await localeTz(page), 1);
      await driveState(page, entry.state, entry.viewport);
    }
  });
}
