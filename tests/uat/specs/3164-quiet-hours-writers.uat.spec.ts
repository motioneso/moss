import { expect, test, type Locator, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { bringUpRealChatModel } from "./real-chat-signin.js";

// Live proof for the three quiet-hours writers: Profile, Moss chat with undo, and the alert
// settings PATCH. Chat turns run through the operator's Codex login and the economy model.
// The briefing writer fixture is scripted, so the worker test proves scheduling and release,
// not a real model reply or a push device. The legacy alert record is arranged by SQL.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const NOTIFICATION_TITLE = "Your morning briefing is ready";
const TIME_ZONE = "America/Chicago";
const ALERTS_KEY = "proactive.monitoring.v1";
const ALERTS_URL = "/api/me/proactive-monitoring-settings";
const STALE_SAVE_MESSAGE =
  "Quiet hours changed somewhere else, so this change was not saved. The latest schedule is showing now.";

const LEGACY_ALERTS = {
  version: 1,
  automaticEmailAlerts: true,
  enabled: true,
  dailyCardCap: 7,
  sources: {
    tasks: { enabled: false, dailyCardCap: 2 },
    notes: { enabled: true, dailyCardCap: 4 }
  },
  quietHours: { enabled: true, startLocalTime: "24:30", endLocalTime: "24:30" },
  updatedAt: "2026-01-01T00:00:00.000Z"
};

type QuietHours = { enabled: boolean; start: string; end: string; timezone: string | null };

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

async function quietHours(page: Page): Promise<{ quietHours: QuietHours; version: string }> {
  const response = await page.request.get("/api/me/quiet-hours");
  expect(response.ok(), `quiet-hours -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as { quietHours: QuietHours; version: string };
}

async function putQuietHours(page: Page, value: QuietHours, expectedVersion: string) {
  const response = await page.request.put("/api/me/quiet-hours", {
    data: { quietHours: value, expectedVersion }
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

function rawPreference(key: string): unknown {
  const row = execUatSql(
    projectName(),
    `SELECT value_json::text FROM app.preferences
     WHERE owner_user_id = '${UAT_ADMIN_ID}' AND key = '${key}'`
  ).trim();
  return row ? JSON.parse(row) : null;
}

async function patchAlerts(page: Page, data: Record<string, unknown>) {
  const response = await page.request.patch(ALERTS_URL, { data });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
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

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendReal(page: Page, drawer: Locator, text: string): Promise<string> {
  const completed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 180_000 }
  );
  await drawer.getByLabel("Message Moss").fill(text);
  await drawer.getByLabel("Message Moss").press("Enter");

  // Installs that ask before tool use show an action card; approve it as a user would.
  let finished = false;
  const settled = completed.then((response) => {
    finished = true;
    return response;
  });
  const approve = page
    .getByRole("region", { name: "Action request" })
    .getByRole("button", { name: "Approve", exact: true })
    .last();
  while (!finished) {
    const shown = await approve.isVisible().catch(() => false);
    if (shown && (await approve.isEnabled().catch(() => false))) {
      await approve.click();
      console.log(`[3164 approved] ${JSON.stringify(text)}`);
      break;
    }
    await page.waitForTimeout(500);
  }
  const response = await settled;
  expect(response.ok(), `real UI turn returned ${response.status()}`).toBe(true);
  const result = (await response.json()) as { reply?: string };
  expect(typeof result.reply).toBe("string");
  expect(result.reply?.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(result.reply!, { exact: true }).last()).toBeVisible();
  console.log(`[3164 real reply] ${JSON.stringify(result.reply!.slice(0, 300))}`);
  return result.reply!;
}

test("Moss chat changes and undoes quiet hours, and undo refuses to overwrite a newer save (#3164)", async ({
  page
}) => {
  test.setTimeout(900_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "host Codex login is required").toBe("1");
  await signIn(page);
  const model = await bringUpRealChatModel(page);
  console.log(`[3164 model] ${model.id}`);
  await page.reload();

  const baseline: QuietHours = { enabled: true, start: "22:00", end: "07:00", timezone: TIME_ZONE };
  const seeded = await putQuietHours(page, baseline, (await quietHours(page)).version);
  expect(seeded.status).toBe(200);

  const drawer = await openChat(page);
  await sendReal(page, drawer, "Set my quiet hours from 21:30 to 06:30.");
  await expect
    .poll(async () => (await quietHours(page)).quietHours, { timeout: 30_000 })
    .toMatchObject({ enabled: true, start: "21:30", end: "06:30", timezone: TIME_ZONE });

  await sendReal(page, drawer, "Undo that quiet hours change.");
  await expect
    .poll(async () => (await quietHours(page)).quietHours, { timeout: 30_000 })
    .toEqual(baseline);

  await sendReal(page, drawer, "Set my quiet hours from 23:15 to 05:45.");
  await expect
    .poll(async () => (await quietHours(page)).quietHours, { timeout: 30_000 })
    .toMatchObject({ start: "23:15", end: "05:45" });
  const afterChat = await quietHours(page);

  // A competing Profile save lands after the chat change; a stale copy of the old version is refused.
  const competing: QuietHours = {
    enabled: true,
    start: "20:00",
    end: "08:00",
    timezone: TIME_ZONE
  };
  expect((await putQuietHours(page, competing, afterChat.version)).status).toBe(200);
  const stale = await putQuietHours(page, { ...competing, start: "19:00" }, afterChat.version);
  expect(stale.status).toBe(409);
  expect((await quietHours(page)).quietHours).toEqual(competing);

  const undoReply = await sendReal(page, drawer, "Undo my last quiet hours change.");
  await page.waitForTimeout(2_000);
  expect((await quietHours(page)).quietHours).toEqual(competing);

  // The turn response carries only the reply, so check its wording loosely for the refusal.
  expect(undoReply).toMatch(
    /changed|didn'?t|did not|couldn'?t|could not|can'?t|cannot|newer|not undo/i
  );
  console.log(
    `[3164 chat proof] chat set 21:30-06:30, undo restored 22:00-07:00, chat set 23:15-05:45, ` +
      `competing save 20:00-08:00 kept after stale save 409 and chat undo (reply ${JSON.stringify(
        undoReply.slice(0, 160)
      )})`
  );
});

test("Profile, alert settings and the briefing worker keep quiet hours safe (#3164)", async ({
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
    .toMatchObject({ locale: { timezone: TIME_ZONE } });

  await page.goto(`${baseUrl()}/settings?section=alerts`);
  const from = page.getByLabel("Quiet hours from");
  const to = page.getByLabel("Quiet hours until");
  await expect(from).toBeEnabled({ timeout: 30_000 });
  await from.fill("22:00");
  await to.fill("07:00");
  const enable = page
    .locator("label.jds-switch")
    .filter({ has: page.locator('input[aria-label="Enable quiet hours"]') });
  if (!(await page.locator('input[aria-label="Enable quiet hours"]').isChecked())) {
    await enable.click();
  }
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(page.getByText("Quiet hours saved.")).toBeVisible();
  await expect
    .poll(async () => (await quietHours(page)).quietHours)
    .toMatchObject({ enabled: true, start: "22:00", end: "07:00" });
  await page.reload();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue("22:00");
  await expect(page.getByLabel("Quiet hours until")).toHaveValue("07:00");

  // A save from the screen over a newer competing save is refused and shows the newer schedule.
  const loaded = await quietHours(page);
  const competing = { ...loaded.quietHours, start: "20:00", end: "08:00" };
  const competingSave = await putQuietHours(page, competing, loaded.version);
  expect(competingSave.status).toBe(200);
  await page.getByLabel("Quiet hours from").fill("19:00");
  await page.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(page.getByText(STALE_SAVE_MESSAGE)).toBeVisible();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue("20:00");
  await expect(page.getByLabel("Quiet hours until")).toHaveValue("08:00");
  expect((await quietHours(page)).quietHours).toEqual(competing);
  console.log(
    `[3164 screen stale save] competing save 20:00-08:00 kept; screen edit to 19:00 refused with message`
  );

  // Invalid Profile saves change nothing, not even the version.
  const before = await quietHours(page);
  const invalid: readonly [string, QuietHours][] = [
    ["equal times", { ...before.quietHours, start: "09:00", end: "09:00" }],
    ["unknown zone", { ...before.quietHours, timezone: "Mars/Olympus" }],
    ["loose time", { ...before.quietHours, start: "7:30" }]
  ];
  for (const [label, value] of invalid) {
    const result = await putQuietHours(page, value, before.version);
    expect(result.status, label).toBe(400);
    console.log(`[3164 invalid profile] ${label} -> 400 ${JSON.stringify(result.body)}`);
  }
  expect(await quietHours(page)).toEqual(before);

  // Alert settings: a record saved by an older build with loose stored times.
  execUatSql(
    projectName(),
    `INSERT INTO app.preferences (owner_user_id, key, value_json)
     VALUES ('${UAT_ADMIN_ID}', '${ALERTS_KEY}', '${JSON.stringify(LEGACY_ALERTS)}'::jsonb)
     ON CONFLICT (owner_user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`
  );
  const profileRaw = rawPreference("quiet-hours");

  const emailOnly = await patchAlerts(page, { automaticEmailAlerts: false });
  expect(emailOnly.status).toBe(200);
  expect(rawPreference(ALERTS_KEY)).toMatchObject({
    automaticEmailAlerts: false,
    dailyCardCap: 7,
    sources: LEGACY_ALERTS.sources,
    quietHours: LEGACY_ALERTS.quietHours
  });

  const equal = await patchAlerts(page, {
    quietHours: { enabled: true, startLocalTime: "09:00", endLocalTime: "09:00" }
  });
  expect(equal.status).toBe(400);
  const loose = await patchAlerts(page, {
    quietHours: { enabled: true, startLocalTime: "7:30", endLocalTime: "08:00" }
  });
  expect(loose.status).toBe(400);
  expect(rawPreference(ALERTS_KEY)).toMatchObject({ quietHours: LEGACY_ALERTS.quietHours });

  const legacyPatch = await patchAlerts(page, {
    quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" }
  });
  expect(legacyPatch.status).toBe(200);
  expect(rawPreference(ALERTS_KEY)).toMatchObject({
    automaticEmailAlerts: false,
    dailyCardCap: 7,
    sources: LEGACY_ALERTS.sources,
    quietHours: { enabled: true, startLocalTime: "21:00", endLocalTime: "06:00" }
  });
  expect(rawPreference("quiet-hours")).toEqual(profileRaw);
  console.log(
    `[3164 alerts proof] email-only kept raw 24:30/24:30, equal and loose -> ${equal.status}/${loose.status}, ` +
      `alerts window 21:00-06:00 saved with sources and cap kept, Profile record untouched`
  );

  // The briefing worker honors the final saved Profile window.
  const now = new Date();
  const scheduledAt = new Date(now.getTime());
  scheduledAt.setUTCSeconds(0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + 2);
  const releaseAt = new Date(scheduledAt.getTime() + 3 * 60_000);
  const start = hhmm(now);
  const end = hhmm(releaseAt);

  await from.fill(start);
  await expect.poll(async () => (await quietHours(page)).quietHours.start).toBe(start);
  await to.fill(end);
  await expect.poll(async () => (await quietHours(page)).quietHours.end).toBe(end);
  await expect
    .poll(async () => (await quietHours(page)).quietHours)
    .toMatchObject({ enabled: true, start, end });

  const definition = await page.request.post("/api/briefings/definitions", {
    data: {
      title: "3164 scheduled quiet-hours proof",
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
    .poll(async () => (await briefingNotifications(page)).map((item) => item.id), {
      timeout: 30_000
    })
    .toHaveLength(1);
  const [released] = await briefingNotifications(page);
  await page.waitForTimeout(1_000);
  expect((await briefingNotifications(page)).map((item) => item.id)).toEqual([released!.id]);
  console.log(
    `[3164 worker proof] final Profile window ${start}-${end} ${TIME_ZONE}; no notification before ` +
      `${releaseAt.toISOString()}, exactly one after`
  );
});
