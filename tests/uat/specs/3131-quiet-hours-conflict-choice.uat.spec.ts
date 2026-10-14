import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// Live proof that an owner settles differing saved quiet hours in Settings > Alerts & quiet hours
// (#3131). The differing records come from older builds, which this build's writers cannot
// produce, so SQL arranges them. The choice, its failure, the reload and every notification go
// through the installed app. The failed choice is a real one: the browser goes offline, so no
// response is faked or rewritten. The briefing writer fixture is scripted; it proves scheduling
// and release only, not a real model reply or a push device.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const NOTIFICATION_TITLE = "Your morning briefing is ready";
const TIME_ZONE = "America/Chicago";
const ALERTS_KEY = "proactive.monitoring.v1";
const PROFILE_KEY = "quiet-hours";
const DIFFER_NOTE = "Your saved quiet hours differ.";

type QuietHoursRead = {
  quietHours: { enabled: boolean; start: string; end: string; timezone: string | null };
  authority: { status: string; alerts: { enabled: boolean; start: string; end: string } | null };
  version: string | null;
};

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function projectName(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value?.startsWith("uat-"))
    throw new Error("JARVIS_UAT_PROJECT_NAME must name an isolated UAT stack");
  return value;
}

function sql(statement: string): string {
  return execUatSql(projectName(), statement).trim();
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

function alertsRecord(quietHours: { enabled: boolean; start: string; end: string }) {
  return {
    version: 1,
    automaticEmailAlerts: true,
    enabled: true,
    dailyCardCap: 8,
    sources: { tasks: { enabled: true, dailyCardCap: 3 } },
    quietHours: {
      enabled: quietHours.enabled,
      startLocalTime: quietHours.start,
      endLocalTime: quietHours.end
    },
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function rawPreference(key: string): unknown {
  const row = sql(
    `SELECT value_json::text FROM app.preferences
     WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = '${key}'`
  );
  return row ? JSON.parse(row) : null;
}

function setRawPreference(key: string, value: unknown): void {
  sql(
    `INSERT INTO app.preferences (owner_user_id, key, value_json)
     VALUES ('${UAT_ADMIN_ID}', '${key}', '${JSON.stringify(value)}'::jsonb)
     ON CONFLICT (owner_user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`
  );
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

async function quietHours(page: Page): Promise<QuietHoursRead> {
  const response = await page.request.get("/api/me/quiet-hours");
  expect(response.ok(), `quiet-hours -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as QuietHoursRead;
}

async function briefingNotifications(page: Page) {
  const response = await page.request.get("/api/notifications");
  expect(response.ok(), `notifications -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    notifications: readonly { id: string; title: string }[];
  };
  return body.notifications.filter((item) => item.title === NOTIFICATION_TITLE);
}

function summaryJob(releaseAt: Date): { readonly state: string; readonly output: unknown } | null {
  const row = sql(
    `SELECT state || '|' || COALESCE(output::text, 'null')
     FROM pgboss.job
     WHERE name = 'notifications.push.summary'
       AND data->>'recipientUserId' = '${UAT_ADMIN_ID}'
       AND data->>'releaseAt' = '${releaseAt.toISOString()}'
     ORDER BY created_on DESC
     LIMIT 1`
  );
  if (!row) return null;
  const [state, output] = row.split("|", 2);
  if (!state || output === undefined) throw new Error(`Malformed summary-job row: ${row}`);
  return { state, output: JSON.parse(output) };
}

/** A daily briefing two minutes out; resolves once its scheduled run has succeeded. */
async function briefingRun(page: Page, title: string): Promise<void> {
  const scheduledAt = new Date();
  scheduledAt.setUTCSeconds(0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + 2);
  const definition = await page.request.post("/api/briefings/definitions", {
    data: {
      title,
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
}

test("an owner chooses between differing saved quiet hours, and a failed choice changes nothing (#3131)", async ({
  page,
  context
}) => {
  test.setTimeout(900_000);
  await signIn(page);
  await page.goto(`${baseUrl()}/settings?section=profile`);
  await page.getByRole("combobox", { name: "Time zone" }).click();
  await page.getByRole("searchbox", { name: "Search time zone" }).fill("Chicago");
  await page.getByRole("option", { name: /America\/Chicago/ }).click();
  await expect
    .poll(async () => (await page.request.get("/api/me/locale")).json())
    .toMatchObject({ locale: { timezone: TIME_ZONE } });

  // 1. Older records differ: Profile is off, the alert schedule is a window that wraps past
  // midnight, so it covers now and ends at releaseAt.
  const releaseAt = new Date();
  releaseAt.setUTCSeconds(0, 0);
  releaseAt.setUTCMinutes(releaseAt.getUTCMinutes() + 12);
  const start = hhmm(new Date(releaseAt.getTime() + 60_000));
  const end = hhmm(releaseAt);
  expect(start > end, `window ${start}-${end} must wrap past midnight`).toBe(true);
  const profileOff = { enabled: false, start: "22:00", end: "07:00", timezone: null };
  const alertsWindow = { enabled: true, start, end };
  setRawPreference(PROFILE_KEY, profileOff);
  setRawPreference(ALERTS_KEY, alertsRecord(alertsWindow));
  const alertsBefore = rawPreference(ALERTS_KEY);
  expect((await quietHours(page)).authority).toEqual({ status: "conflict", alerts: alertsWindow });

  await page.goto(`${baseUrl()}/settings?section=alerts`);
  const column = page.locator(".alerts-pane__quiet");
  const keepOff = column.getByRole("button", { name: "Keep quiet hours off" });
  const useWindow = column.getByRole("button", { name: `Use ${start} to ${end}` });
  await expect(column.getByText(DIFFER_NOTE)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(column.getByText(DIFFER_NOTE)).toBeVisible({ timeout: 30_000 });
  await expect(keepOff).toBeVisible();
  await expect(useWindow).toBeVisible();
  await expect(page.getByLabel("Quiet hours from")).toHaveCount(0);
  await expect(column.getByRole("button", { name: "Save quiet hours" })).toHaveCount(0);
  expect(rawPreference(PROFILE_KEY)).toEqual(profileOff);
  console.log(`[3131 offer] reload shows Keep quiet hours off and Use ${start} to ${end}, no form`);

  // The offer at desktop and phone width in light and dark. Pictures of the quiet column only
  // are bounded evidence; the layout asserts carry the check.
  const desktop = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"] as const) {
      await page.evaluate((m) => document.documentElement.setAttribute("data-color-mode", m), mode);
      const keepBox = await keepOff.boundingBox();
      const useBox = await useWindow.boundingBox();
      expect(keepBox && useBox).toBeTruthy();
      const sameRow = Math.abs(keepBox!.y - useBox!.y) < 2;
      const gap = sameRow
        ? useBox!.x - (keepBox!.x + keepBox!.width)
        : useBox!.y - (keepBox!.y + keepBox!.height);
      expect(gap, `gap between choices at ${width} ${mode}`).toBeGreaterThanOrEqual(8);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await column.screenshot({ path: test.info().outputPath(`choice-${width}-${mode}.png`) });
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "light"));
  if (desktop) await page.setViewportSize(desktop);
  console.log(`[3131 look] desktop and phone, light and dark: choices 8px apart, no overflow`);
  console.log(`[3131 look] pictures in ${test.info().outputDir}`);

  // 2. A real failed choice keeps both records and the offer.
  await context.setOffline(true);
  try {
    await useWindow.click();
    await expect(
      column.getByText(/Your choice could not save: .+\. Your previous schedules still apply\./)
    ).toBeVisible();
    await expect(column.getByText(DIFFER_NOTE)).toBeVisible();
    await expect(column.getByRole("button", { name: "Try again" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  expect(rawPreference(PROFILE_KEY)).toEqual(profileOff);
  expect(rawPreference(ALERTS_KEY)).toEqual(alertsBefore);
  expect((await quietHours(page)).authority.status).toBe("conflict");
  console.log(`[3131 failed choice] offline choice refused; both saved records unchanged`);

  // 3. Old behaviour holds: Profile is off, so a notification inside the alert window arrives
  // at once rather than waiting for its end.
  await briefingRun(page, "3131 before the choice");
  await expect
    .poll(async () => (await briefingNotifications(page)).length, { timeout: 30_000 })
    .toBe(1);
  expect(Date.now()).toBeLessThan(releaseAt.getTime());
  console.log(`[3131 old behaviour] notification inside ${start}-${end} arrived at once`);

  // 4. Try again saves the same choice; the alert window now governs every consumer.
  await column.getByRole("button", { name: "Try again" }).click();
  await expect(
    column.getByText(`Using your saved email alert schedule: ${start} to ${end}.`)
  ).toBeVisible();
  const resolved = await quietHours(page);
  expect(resolved.authority.status).toBe("canonical");
  expect(resolved.quietHours).toEqual({ ...alertsWindow, timezone: null });
  expect(rawPreference(ALERTS_KEY)).toEqual(alertsBefore);
  await page.reload();
  await expect(
    column.getByText(
      `Saved schedule: every day, ${start} to ${end}, your profile time zone (${TIME_ZONE}).`
    )
  ).toBeVisible({ timeout: 30_000 });
  await expect(column.getByText(DIFFER_NOTE)).toHaveCount(0);
  await expect(page.getByLabel("Quiet hours from")).toHaveValue(start);
  console.log(`[3131 choice] Try again saved ${start}-${end} as the one schedule; reload agrees`);

  // A repeated choice from the old screen writes nothing and is not an error.
  const repeat = await page.request.post("/api/me/quiet-hours/resolution", {
    data: {
      choice: "alerts",
      quietHours: { ...alertsWindow, timezone: null },
      expectedVersion: "stale-tab"
    }
  });
  expect(repeat.status()).toBe(200);
  expect((await quietHours(page)).version).toBe(resolved.version);
  console.log(`[3131 repeat] repeated choice -> 200, version unchanged`);

  // 5. New behaviour: a notification inside the window is held until its end, then released once.
  await briefingRun(page, "3131 after the choice");
  expect(Date.now()).toBeLessThan(releaseAt.getTime());
  expect(await briefingNotifications(page)).toHaveLength(1);
  await expect.poll(() => summaryJob(releaseAt)).toEqual({ state: "created", output: null });
  const waitMs = Math.max(0, releaseAt.getTime() - Date.now() + 2_000);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await expect
    .poll(async () => (await briefingNotifications(page)).length, { timeout: 30_000 })
    .toBe(2);
  await expect
    .poll(() => summaryJob(releaseAt), { timeout: 30_000 })
    .toEqual({
      state: "completed",
      output: { delivered: 0, alreadyDelivered: 0, temporaryFailures: 0, reasons: [] }
    });
  console.log(
    `[3131 new behaviour] notification held under the chosen schedule, released once at ` +
      releaseAt.toISOString()
  );
});
