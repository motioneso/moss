// Isolated live UI proof. Only the third-party Outlook collector is an invented stand-in;
// auth, Settings actions, queue, importer, RLS, API and Calendar UI run their real paths.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { createDatabase, DataContextRunner } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { localDayKey, strictLocalWallClockToInstant } from "@moss/module-sdk";
import { createApiServer } from "../../apps/api/src/server.js";
import { seedSoloAdmin, UAT_ADMIN_ID } from "../uat/seed/admin.js";
import { seedOnboardingChunk } from "../uat/seed/chunks/onboarding.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";
import { outlookCalendarBinding } from "../../packages/connectors/src/outlook-calendar-config.js";
import {
  OUTLOOK_CALENDAR_QUEUE,
  runOutlookCalendarSync
} from "../../packages/connectors/src/outlook-calendar-jobs.js";
import { OutlookCalendarSourceError } from "../../packages/connectors/src/outlook-calendar-source.js";

const apiPort = Number(process.env.MOSS_CALENDAR_UI_API_PORT);
const webPort = Number(process.env.MOSS_CALENDAR_UI_WEB_PORT);
const enabled = apiPort >= 5180 && apiPort <= 5299 && webPort >= 5180 && webPort <= 5299;
describe.skipIf(!enabled)("Outlook isolated live UI", () => {
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  let server: ReturnType<typeof createApiServer> | undefined;
  let cleanup: (() => Promise<unknown>) | undefined;
  afterAll(async () => {
    await browser?.close();
    vite?.kill("SIGTERM");
    await server?.close();
    await cleanup?.();
  });
  it("connects in Settings, displays a read-only event and retains it after source failure and disconnect", async () => {
    await resetEmptyFoundationDatabase();
    const migrationDb = createDatabase({ connectionString: connectionStrings.migration });
    const credentials = await seedSoloAdmin(migrationDb);
    await migrationDb.destroy();
    const appDb = createDatabase({ connectionString: connectionStrings.app });
    const workerDb = createDatabase({ connectionString: connectionStrings.worker });
    const boss = createPgBossClient(connectionStrings.app);
    const workerBoss = createPgBossClient(connectionStrings.worker);
    cleanup = () =>
      Promise.allSettled([
        boss.stop({ graceful: false }),
        workerBoss.stop({ graceful: false }),
        appDb.destroy(),
        workerDb.destroy()
      ]);
    await seedOnboardingChunk(new DataContextRunner(appDb), UAT_ADMIN_ID);
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "invented-ui-test-key";
    process.env.MOSS_OUTLOOK_BROWSER_OWNER = UAT_ADMIN_ID;
    process.env.MOSS_OUTLOOK_BROWSER_ENDPOINT = "http://127.0.0.1:5188";
    process.env.MOSS_OUTLOOK_BROWSER_ACCOUNT = "invented@example.invalid";
    process.env.JARVIS_AUTH_BASE_URL = `http://127.0.0.1:${apiPort}`;
    process.env.JARVIS_AUTH_TRUSTED_ORIGINS = `http://127.0.0.1:${apiPort},http://127.0.0.1:${webPort}`;
    const binding = outlookCalendarBinding()!;
    let failSource = false;
    let scans = 0;
    await boss.start();
    await workerBoss.start();
    await workerBoss.work(OUTLOOK_CALENDAR_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
      await runOutlookCalendarSync(new DataContextRunner(workerDb), binding, async () => {
        if (failSource) throw new OutlookCalendarSourceError("sign-in-needed");
        scans++;
        const day = localDayKey(new Date(), "America/Los_Angeles");
        const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
        return {
          calendarKey: "primary",
          timeZone: "America/Los_Angeles",
          observedAt: new Date().toISOString(),
          windowStart: day,
          windowEnd: next,
          complete: true,
          views: 1,
          events: [
            {
              occurrenceKey: "invented-ui-occurrence",
              title: "Invented Outlook proof",
              startsAt: strictLocalWallClockToInstant(
                `${day}T10:00:00`,
                "America/Los_Angeles"
              ).toISOString(),
              endsAt: strictLocalWallClockToInstant(
                `${day}T11:00:00`,
                "America/Los_Angeles"
              ).toISOString(),
              allDay: false,
              timeZone: "America/Los_Angeles"
            }
          ]
        };
      });
    });
    server = createApiServer({ appDb, workerDb, boss, logger: false });
    await server.listen({ host: "127.0.0.1", port: apiPort });
    vite = spawn(
      "pnpm",
      [
        "--filter",
        "@moss/web",
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort"
      ],
      {
        env: { ...process.env, JARVIS_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
        stdio: "ignore"
      }
    );
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${webPort}`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 30000 }
      )
      .toBe(true);
    browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    await page.goto(`http://127.0.0.1:${webPort}/login`);
    await page.getByLabel("Email", { exact: true }).fill(credentials.email);
    await page.getByLabel("Password", { exact: true }).fill(credentials.password);
    await page
      .locator("form.auth-form")
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 30000 });
    await page.goto(`http://127.0.0.1:${webPort}/settings?section=connections`);
    const panel = page.getByLabel("Outlook calendar connection");
    await panel.getByRole("button", { name: "Connect Outlook calendar", exact: true }).click();
    await browserExpect(panel).toContainText("Last complete refresh", { timeout: 45000 });
    await panel.getByRole("button", { name: "Sync now", exact: true }).click();
    await expect.poll(() => scans, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    await page.goto(`http://127.0.0.1:${webPort}/calendar`);
    await browserExpect(page.getByText("Invented Outlook proof", { exact: true })).toBeVisible();
    await page.getByText("Invented Outlook proof", { exact: true }).click();
    await browserExpect(page.getByLabel("Event details")).toContainText("Outlook · Read only");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const events = await page.request.get(`http://127.0.0.1:${webPort}/api/calendar/events`);
    expect(events.ok()).toBe(true);
    const dto = await events.json();
    expect(
      dto.events.filter((e: { title: string }) => e.title === "Invented Outlook proof")
    ).toHaveLength(1);
    failSource = true;
    await page.goto(`http://127.0.0.1:${webPort}/settings?section=connections`);
    await panel.getByRole("button", { name: "Sync now", exact: true }).click();
    await browserExpect(panel).toContainText("Outlook sign-in required", { timeout: 45000 });
    await browserExpect(panel).toContainText("Last complete refresh");
    await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
    await browserExpect(panel).toContainText("updates paused");
    await page.goto(`http://127.0.0.1:${webPort}/calendar`);
    await browserExpect(page.getByText("Invented Outlook proof", { exact: true })).toBeVisible();
    console.log(
      "UI proof: real login → Settings connect → queued imports → one read-only Calendar event → sign-in warning retains checkpoint → disconnected cache visible. Third-party collector: invented fixture."
    );
  }, 180000);
});
