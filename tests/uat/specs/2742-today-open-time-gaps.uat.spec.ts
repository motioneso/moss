import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2742: the Today schedule must show the real gaps between the day's blocks — a short break, or
// open time — derived only from the blocks' own times, plus a closing line after the last one.
// admin+data lands straight on Today (no onboarding wizard) so the seeded tasks below are the
// only schedule content for the day; this spec builds its own gaps rather than relying on the
// ladder's own task seed, whose due time floats relative to real wall-clock time.
export const uatLevel = { level: "admin+data", without: [] } as const;

const TZ = "America/Los_Angeles";

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

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
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
}

async function createTask(page: Page, title: string): Promise<string> {
  const r = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt: null })
  });
  expect(r.status).toBe(201);
  return r.body.task.id as string;
}

// Three blocks, two gaps: 9:00-9:30 then a 15-minute break (short of the 30-minute
// break/open-time threshold), then 9:45-10:15, then a 90-minute open-time gap, then
// 11:45-12:15 — the day's last commitment, so a closing line follows it.
async function seedDayPlanWithGaps(page: Page, timeZone: string): Promise<void> {
  const taskA = await createTask(page, "2742 morning block A");
  const taskB = await createTask(page, "2742 morning block B");
  const taskC = await createTask(page, "2742 morning block C");
  const created = await json(page, "/api/calendar/day-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: SERVER_DAY, timeZone })
  });
  expect(created.status).toBe(200);
  const blocks = [
    { taskId: taskA, startsAt: localIso(SERVER_DAY, "09:00"), durationMinutes: 30 },
    { taskId: taskB, startsAt: localIso(SERVER_DAY, "09:45"), durationMinutes: 30 },
    { taskId: taskC, startsAt: localIso(SERVER_DAY, "11:45"), durationMinutes: 30 }
  ].map((b) => ({
    kind: "focus",
    taskId: b.taskId,
    title: null,
    pendingChange: { kind: "add", startsAt: b.startsAt, durationMinutes: b.durationMinutes }
  }));
  const draft = await json(page, `/api/calendar/day-plans/${created.body.plan.id}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: SERVER_DAY,
      timeZone,
      expectedRevision: created.body.plan.revision,
      blocks
    })
  });
  expect(draft.status).toBe(200);
}

async function assertScheduleGapsRender(page: Page): Promise<void> {
  await page.goto(baseURL());
  const gapRows = page.locator(".tl-slot--gap");
  await expect(gapRows).toHaveCount(2);
  await expect(gapRows.nth(0)).toContainText("A break before the next block");
  await expect(gapRows.nth(1)).toContainText("Open time");
  await expect(page.locator(".tl-legend")).toContainText("Open time");
  await expect(page.locator(".tl-closing")).toContainText("The evening is open");
  await expect(page.locator(".tl-closing")).toContainText("12:15");
}

test("Today shows a break row, an open-time row, the legend entry, and the closing line", async ({
  page
}) => {
  await signIn(page);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  await seedDayPlanWithGaps(page, timeZone);

  await page.setViewportSize({ width: 1440, height: 900 });
  await assertScheduleGapsRender(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await assertScheduleGapsRender(page);
});
