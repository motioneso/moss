import { expect, test, type Page } from "@playwright/test";

import { restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// Live proof that saved quiet hours carry into Profile and the real workers (#3165).
// Older-build records (an alert record with its own quiet schedule, a Profile record without the
// authority marker, a malformed record) cannot be produced by this build's writers, so SQL
// arranges them. Every read, save, restart, worker run, notification and card goes through the
// installed app. The briefing writer fixture is scripted; it proves scheduling and release only.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const NOTIFICATION_TITLE = "Your morning briefing is ready";
const TIME_ZONE = "America/Chicago";
const ALERTS_KEY = "proactive.monitoring.v1";
const PROFILE_KEY = "quiet-hours";
const ALERTS_URL = "/api/me/proactive-monitoring-settings";
const TASK_TITLE = "UAT3165 overdue proof task";

type QuietHours = { enabled: boolean; start: string; end: string; timezone: string | null };
type QuietHoursRead = {
  quietHours: QuietHours;
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

function deleteRawPreference(key: string): void {
  sql(`DELETE FROM app.preferences WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = '${key}'`);
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

async function putQuietHours(page: Page, value: QuietHours, expectedVersion: string | null) {
  const response = await page.request.put("/api/me/quiet-hours", {
    data: { quietHours: value, expectedVersion }
  });
  return response.status();
}

async function patchAlerts(page: Page, data: Record<string, unknown>): Promise<number> {
  return (await page.request.patch(ALERTS_URL, { data })).status();
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

/** Runs the installed tasks scanner worker once, through the public refresh route. */
async function runTasksScanner(page: Page): Promise<void> {
  sql(
    `DELETE FROM app.proactive_monitor_state WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'tasks'`
  );
  const response = await page.request.post("/api/me/proactive-cards/refresh");
  expect(response.status()).toBe(202);
  expect(((await response.json()) as { enqueued: number }).enqueued).toBeGreaterThanOrEqual(1);
  await expect
    .poll(
      () =>
        sql(
          `SELECT count(*) FROM app.proactive_monitor_state WHERE owner_user_id = '${UAT_ADMIN_ID}'
           AND source = 'tasks' AND last_checked_at IS NOT NULL AND last_error_class IS NULL`
        ),
      { timeout: 60_000 }
    )
    .toBe("1");
}

function taskCards(): { stableKey: string; deferredUntil: string | null }[] {
  const rows = sql(
    `SELECT stable_key || '|' || COALESCE(to_char(deferred_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')
     FROM app.proactive_cards
     WHERE owner_user_id = '${UAT_ADMIN_ID}' AND source = 'tasks' AND title = '${TASK_TITLE}'`
  );
  return rows
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [stableKey = "", deferredUntil = ""] = row.split("|");
      return { stableKey, deferredUntil: deferredUntil || null };
    });
}

async function visibleTaskCards(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/me/proactive-cards?limit=20");
  expect(response.ok(), `proactive-cards -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { cards: { title: string; stableKey: string }[] };
  return body.cards.filter((card) => card.title === TASK_TITLE).map((card) => card.stableKey);
}

async function openQuietHours(page: Page): Promise<void> {
  await page.goto(`${baseUrl()}/settings?section=alerts`);
  await expect(page.getByLabel("Quiet hours from")).toBeEnabled({ timeout: 30_000 });
}

test("saved quiet hours carry into Profile and the installed workers (#3165)", async ({ page }) => {
  test.setTimeout(900_000);
  await signIn(page);
  await page.goto(`${baseUrl()}/settings?section=profile`);
  await page.getByRole("combobox", { name: "Time zone" }).click();
  await page.getByRole("searchbox", { name: "Search time zone" }).fill("Chicago");
  await page.getByRole("option", { name: /America\/Chicago/ }).click();
  await expect
    .poll(async () => (await page.request.get("/api/me/locale")).json())
    .toMatchObject({ locale: { timezone: TIME_ZONE } });

  // 1. Sole alert schedule: a near-future quiet window, saved only on the older alert record.
  const now = new Date();
  const scheduledAt = new Date(now.getTime());
  scheduledAt.setUTCSeconds(0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + 2);
  const releaseAt = new Date(scheduledAt.getTime() + 3 * 60_000);
  const sole = { enabled: true, start: hhmm(now), end: hhmm(releaseAt) };
  deleteRawPreference(PROFILE_KEY);
  setRawPreference(ALERTS_KEY, alertsRecord(sole));

  const carried = await quietHours(page);
  expect(carried.authority.status).toBe("carried");
  expect(carried.quietHours).toMatchObject(sole);
  expect(rawPreference(PROFILE_KEY)).toBeNull();
  console.log(`[3165 sole] alert-only window ${sole.start}-${sole.end} ${TIME_ZONE} reads carried`);

  // 2. Real workers follow the carried window: the tasks scanner and the briefing notification.
  const task = await page.request.post("/api/tasks", {
    data: { title: TASK_TITLE, priority: 5, dueAt: "2020-01-02T15:00:00.000Z" }
  });
  expect(task.status(), `task -> ${task.status()}`).toBe(201);
  const definition = await page.request.post("/api/briefings/definitions", {
    data: {
      title: "3165 carried quiet-hours proof",
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

  await runTasksScanner(page);
  const deferred = taskCards();
  expect(deferred).toHaveLength(1);
  expect(deferred[0]!.deferredUntil).toBe(releaseAt.toISOString());
  expect(await visibleTaskCards(page)).toEqual([]);
  console.log(
    `[3165 scanner] worker completed; card ${deferred[0]!.stableKey} deferred to ${releaseAt.toISOString()}, hidden from the card list`
  );

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
  expect(rawPreference(PROFILE_KEY)).toBeNull();

  const waitMs = Math.max(0, releaseAt.getTime() - Date.now() + 2_000);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await expect
    .poll(async () => (await briefingNotifications(page)).map((item) => item.id), {
      timeout: 30_000
    })
    .toHaveLength(1);
  await expect.poll(() => visibleTaskCards(page)).toEqual([deferred[0]!.stableKey]);
  await runTasksScanner(page);
  expect(taskCards().map((card) => card.stableKey)).toEqual([deferred[0]!.stableKey]);
  expect(await visibleTaskCards(page)).toEqual([deferred[0]!.stableKey]);
  expect(await briefingNotifications(page)).toHaveLength(1);
  expect(rawPreference(PROFILE_KEY)).toBeNull();
  console.log(
    `[3165 boundary] no notification or card before ${releaseAt.toISOString()}; after it exactly one ` +
      `notification and one visible card, same identity after a second scanner run; Profile row still absent`
  );

  // 3. Upgrade under disclosed authority: restart reruns migrations and boot; nothing is written.
  const alertsBeforeRestart = rawPreference(ALERTS_KEY);
  await restartUatStack(projectName(), baseUrl());
  expect(rawPreference(PROFILE_KEY)).toBeNull();
  expect(rawPreference(ALERTS_KEY)).toEqual(alertsBeforeRestart);
  await openQuietHours(page);
  await expect(page.getByLabel("Quiet hours from")).toHaveValue(sole.start);
  await expect(page.getByLabel("Quiet hours until")).toHaveValue(sole.end);
  await page.reload();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue(sole.start);
  expect(rawPreference(PROFILE_KEY)).toBeNull();
  console.log(`[3165 upgrade] restart and reload kept ${sole.start}-${sole.end} carried, no write`);

  // 4. A save from an older read is refused once the legacy alert form moved the schedule.
  const olderRead = await quietHours(page);
  expect(
    await patchAlerts(page, {
      quietHours: { enabled: true, startLocalTime: "21:30", endLocalTime: "06:15" }
    })
  ).toBe(200);
  expect(rawPreference(PROFILE_KEY)).toMatchObject({
    enabled: true,
    start: "21:30",
    end: "06:15",
    authority: "canonical"
  });
  expect(rawPreference(ALERTS_KEY)).toEqual(alertsBeforeRestart);
  expect(
    await putQuietHours(
      page,
      { ...olderRead.quietHours, start: "20:00", end: "05:00" },
      olderRead.version
    )
  ).toBe(409);
  expect((await quietHours(page)).quietHours).toMatchObject({ start: "21:30", end: "06:15" });
  console.log(`[3165 legacy form] edit landed on Profile as canonical; older read save -> 409`);

  // 5. A screen edit keeps one canonical schedule and leaves the alert record alone.
  await openQuietHours(page);
  await page.getByLabel("Quiet hours from").fill("21:45");
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect.poll(async () => (await quietHours(page)).quietHours.start).toBe("21:45");
  const afterProfile = await quietHours(page);
  expect(afterProfile.authority.status).toBe("canonical");
  expect(rawPreference(ALERTS_KEY)).toEqual(alertsBeforeRestart);
  await page.reload();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue("21:45");
  await expect(page.getByText("Email alerts still follow an older schedule")).toHaveCount(0);
  console.log(`[3165 profile edit] 21:45-06:15 canonical after reload, alert record untouched`);

  // 6. Identical older records carry, including a Profile zone equal to the owner zone.
  for (const timezone of [null, TIME_ZONE]) {
    setRawPreference(PROFILE_KEY, { enabled: true, start: "22:00", end: "07:00", timezone });
    setRawPreference(ALERTS_KEY, alertsRecord({ enabled: true, start: "22:00", end: "07:00" }));
    const identical = await quietHours(page);
    expect(identical.authority.status, `identical tz ${timezone}`).toBe("carried");
    expect(rawPreference(PROFILE_KEY)).toEqual({
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone
    });
  }
  console.log(
    `[3165 identical] same window with zone unset or ${TIME_ZONE} reads carried, no write`
  );

  // 7. Conflicts stay unresolved through reads, an unrelated email save and a repeated upgrade.
  const zoneConflict = {
    enabled: true,
    start: "22:00",
    end: "07:00",
    timezone: "America/New_York"
  };
  setRawPreference(PROFILE_KEY, zoneConflict);
  expect((await quietHours(page)).authority.status).toBe("conflict");

  const conflicts = [
    {
      label: "schedule",
      profile: { enabled: true, start: "22:00", end: "07:00", timezone: null },
      alerts: { enabled: true, start: "23:00", end: "08:00" },
      note: "Email alerts still follow an older schedule, 23:00 to 08:00."
    },
    {
      label: "enabled",
      profile: { enabled: false, start: "22:00", end: "07:00", timezone: null },
      alerts: { enabled: true, start: "22:00", end: "07:00" },
      note: "Email alerts still follow an older schedule, 22:00 to 07:00."
    }
  ];
  for (const [index, conflict] of conflicts.entries()) {
    setRawPreference(PROFILE_KEY, conflict.profile);
    setRawPreference(ALERTS_KEY, alertsRecord(conflict.alerts));
    const read = await quietHours(page);
    expect(read.authority).toEqual({ status: "conflict", alerts: conflict.alerts });
    expect(await patchAlerts(page, { automaticEmailAlerts: false })).toBe(200);
    expect((await quietHours(page)).authority.status).toBe("conflict");
    expect(rawPreference(PROFILE_KEY)).toEqual(conflict.profile);
    expect(rawPreference(ALERTS_KEY)).toMatchObject({
      automaticEmailAlerts: false,
      quietHours: alertsRecord(conflict.alerts).quietHours
    });
    if (index === conflicts.length - 1) {
      await restartUatStack(projectName(), baseUrl());
    }
    await openQuietHours(page);
    await page.reload();
    await expect(page.getByText(conflict.note)).toBeVisible();
    expect(rawPreference(PROFILE_KEY)).toEqual(conflict.profile);
    expect((await quietHours(page)).authority.status).toBe("conflict");
    console.log(`[3165 conflict ${conflict.label}] unchanged after email save, reload and restart`);
  }

  // 8. A malformed record is kept as it is.
  setRawPreference(PROFILE_KEY, { enabled: "yes", start: "22:00", end: "07:00" });
  expect((await quietHours(page)).authority.status).toBe("malformed");
  expect(await patchAlerts(page, { automaticEmailAlerts: true })).toBe(200);
  expect(rawPreference(PROFILE_KEY)).toEqual({ enabled: "yes", start: "22:00", end: "07:00" });
  console.log(`[3165 malformed] kept unchanged through a read and an email save`);
});
