import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// Uses the actual Settings controls (the Alerts & quiet hours editor) and installed scheduling
// worker. Its disposable third-party briefing writer fixture is scripted, so this does not prove
// a real model reply or push device.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const NOTIFICATION_TITLE = "Your morning briefing is ready";
const TIME_ZONE = "America/Chicago";

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function hhmm(date: Date): string {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit"
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return `${parts.get("hour")}:${parts.get("minute")}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseUrl());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 30_000 });
}

async function saveQuietHours(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(page.getByText("Quiet hours saved.")).toBeVisible();
}

async function quietHours(page: Page) {
  const response = await page.request.get("/api/me/quiet-hours");
  expect(response.ok(), `quiet-hours -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as {
    quietHours: { enabled: boolean; start: string; end: string; timezone: string | null };
  };
}

async function notifications(page: Page) {
  const response = await page.request.get("/api/notifications");
  expect(response.ok(), `notifications -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as { notifications: readonly { id: string; title: string }[] };
}

async function briefingNotifications(page: Page) {
  return (await notifications(page)).notifications.filter(
    (item) => item.title === NOTIFICATION_TITLE
  );
}

function projectName(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value?.startsWith("uat-"))
    throw new Error("JARVIS_UAT_PROJECT_NAME must name an isolated UAT stack");
  return value;
}

function summaryJob(releaseAt: Date): { readonly state: string; readonly output: unknown } | null {
  const row = execUatSql(
    projectName(),
    `SELECT state || '|' || COALESCE(output::text, 'null')
     FROM pgboss.job
     WHERE name = 'notifications.push.summary'
       AND data->>'recipientUserId' = '${UAT_ADMIN_ID}'
       AND data->>'releaseAt' = '${releaseAt.toISOString()}'
     ORDER BY created_on DESC
     LIMIT 1`
  ).trim();
  if (!row) return null;
  const [state, output] = row.split("|", 2);
  if (!state || output === undefined) throw new Error(`Malformed summary-job row: ${row}`);
  return { state, output: JSON.parse(output) };
}

test("Saved quiet hours defer a scheduled briefing notification until the saved local end (#3158)", async ({
  page
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await page.goto(`${baseUrl()}/settings?section=profile`);

  await page.getByRole("combobox", { name: "Time zone" }).click();
  await page.getByRole("searchbox", { name: "Search time zone" }).fill("Chicago");
  await page.getByRole("option", { name: /America\/Chicago/ }).click();
  await expect
    .poll(async () => (await page.request.get("/api/me/locale")).json())
    .toMatchObject({
      locale: { timezone: TIME_ZONE }
    });

  await page.goto(`${baseUrl()}/settings?section=alerts`);
  const from = page.getByLabel("Quiet hours from");
  const to = page.getByLabel("Quiet hours until");
  await expect(from).toBeEnabled({ timeout: 30_000 });
  await from.fill("22:00");
  await to.fill("07:00");
  await page
    .locator("label.jds-switch")
    .filter({ has: page.locator('input[aria-label="Enable quiet hours"]') })
    .click();
  await saveQuietHours(page);
  await expect
    .poll(async () => (await quietHours(page)).quietHours)
    .toMatchObject({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: null
    });
  await page.reload();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue("22:00");
  await expect(page.getByLabel("Quiet hours until")).toHaveValue("07:00");
  await expect
    .poll(async () => (await page.request.get("/api/me/locale")).json())
    .toMatchObject({ locale: { timezone: TIME_ZONE } });

  const now = new Date();
  const scheduledAt = new Date(now.getTime());
  scheduledAt.setUTCSeconds(0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + 2);
  const releaseAt = new Date(scheduledAt.getTime() + 3 * 60_000);
  const start = hhmm(now);
  const end = hhmm(releaseAt);

  await from.fill(start);
  await to.fill(end);
  await saveQuietHours(page);
  await expect
    .poll(async () => (await quietHours(page)).quietHours)
    .toMatchObject({
      enabled: true,
      start,
      end,
      timezone: null
    });
  const definition = await page.request.post("/api/briefings/definitions", {
    data: {
      title: "3158 scheduled quiet-hours proof",
      briefingType: "morning",
      cadence: "daily",
      enabled: true,
      scheduleMetadata: {
        version: 1,
        targetTime: hhmm(scheduledAt),
        timezone: TIME_ZONE,
        quietHoursBehavior: "defer_notification"
      },
      selectedToolNames: ["tasks.list"]
    }
  });
  expect(definition.status(), `definition -> ${definition.status()}`).toBe(201);
  const definitionId = ((await definition.json()) as { definition: { id: string } }).definition.id;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/briefings/definitions/${definitionId}/runs`);
        if (!response.ok()) return undefined;
        return (
          (await response.json()) as { runs: { runKind: string; status: string }[] }
        ).runs.find((run) => run.runKind === "scheduled")?.status;
      },
      { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe("succeeded");

  expect(Date.now()).toBeLessThan(releaseAt.getTime());
  expect(await briefingNotifications(page)).toHaveLength(0);
  await expect.poll(() => summaryJob(releaseAt)).toEqual({ state: "created", output: null });

  const waitMs = Math.max(0, releaseAt.getTime() - Date.now() + 2_000);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await expect
    .poll(async () => briefingNotifications(page).then((items) => items.map((item) => item.id)), {
      timeout: 30_000
    })
    .toHaveLength(1);
  const [released] = await briefingNotifications(page);
  expect(released?.id).toEqual(expect.any(String));
  await page.waitForTimeout(1_000);
  expect((await briefingNotifications(page)).map((item) => item.id)).toEqual([released!.id]);
  await expect
    .poll(() => summaryJob(releaseAt), { timeout: 30_000 })
    .toEqual({
      state: "completed",
      output: { delivered: 0, alreadyDelivered: 0, temporaryFailures: 0, reasons: [] }
    });
  console.log(
    `[3158 live proof] Alerts & quiet hours saved and reloaded overnight ${TIME_ZONE} 22:00-07:00, then saved ` +
      `${start}-${end}; scheduled fixture briefing completed before its notification released once at ` +
      `${releaseAt.toISOString()}`
  );
});
