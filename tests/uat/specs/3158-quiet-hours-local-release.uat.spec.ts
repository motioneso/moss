import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Uses the actual Settings controls, the installed scheduling worker, and the configured
// briefing writer provider. The UAT stack is disposable and has no registered push device.
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
  return (await response.json()) as { notifications: readonly { title: string }[] };
}

test("Profile quiet hours defer a scheduled briefing notification until the saved local end (#3158)", async ({
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

  const now = new Date();
  const scheduledAt = new Date(now.getTime());
  scheduledAt.setUTCSeconds(0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + 2);
  const releaseAt = new Date(scheduledAt.getTime() + 3 * 60_000);
  const start = hhmm(now);
  const end = hhmm(releaseAt);

  const from = page.getByLabel("Quiet hours from");
  const to = page.getByLabel("Quiet hours to");
  await from.fill(start);
  await expect.poll(async () => (await quietHours(page)).quietHours.start).toBe(start);
  await to.fill(end);
  await expect.poll(async () => (await quietHours(page)).quietHours.end).toBe(end);
  await page
    .locator("label.jds-switch")
    .filter({ has: page.locator('input[aria-label="Enable quiet hours"]') })
    .click();
  await expect
    .poll(async () => (await quietHours(page)).quietHours)
    .toMatchObject({
      enabled: true,
      start,
      end,
      timezone: null
    });
  await page.reload();
  await expect(page.getByLabel("Quiet hours from")).toHaveValue(start);
  await expect(page.getByLabel("Quiet hours to")).toHaveValue(end);

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

  expect(
    (await notifications(page)).notifications.some((item) => item.title === NOTIFICATION_TITLE)
  ).toBe(false);

  const waitMs = Math.max(0, releaseAt.getTime() - Date.now() + 2_000);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await expect
    .poll(
      async () =>
        (await notifications(page)).notifications.some((item) => item.title === NOTIFICATION_TITLE),
      {
        timeout: 30_000
      }
    )
    .toBe(true);
  console.log(
    `[3158 live proof] Profile saved ${TIME_ZONE} ${start}-${end}; scheduled configured-provider briefing ` +
      `completed while its normal notification stayed absent until ${releaseAt.toISOString()}`
  );
});
