import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2503: an all-day calendar event is a calendar date, so Today must count it on that date for a
// user whose time zone is west of UTC. Before the fix the event's stored UTC midnight start was
// converted into local time, landing on the previous day, so today's event count missed it.
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

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

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
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
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
        clientId: "t2503-client",
        clientSecret: "t2503-secret",
        accessToken: "t2503-access",
        refreshToken: "t2503-refresh",
        tokenExpiry: "2099-01-01T00:00:00.000Z",
        grantedScopes: ["https://www.googleapis.com/auth/calendar"]
      }
    })
  });
  expect(r.status).toBe(200);
  return account!.id;
}

async function seedAllDayEvent(accountId: string, day: string): Promise<void> {
  const row = {
    title: "UAT2503 all-day holiday",
    startsAt: `${day}T00:00:00.000Z`,
    endsAt: `${nextDay(day)}T00:00:00.000Z`,
    externalId: "uat2503-allday"
  };
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const c=new CalendarRepository(); const row=${JSON.stringify(row)}; await c.upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:row.title,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),externalId:row.externalId,externalMetadata:{allDay:true}});});}finally{await runner.destroy();} console.log("seeded all-day event");})();`;
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
  console.log(`[2503 calendar fixture] ${r.stdout.trim()}`);
}

test("Today counts an all-day event on its own date west of UTC", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const saved = await json(page, "/api/me/locale", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: { ...locale.body.locale, timezone: TZ } })
  });
  expect(saved.status).toBe(200);

  const accountId = await armCalendar(page);
  await seedAllDayEvent(accountId, localDay());

  await page.goto(baseURL());
  const lede = page.getByText(/event(s)? on the calendar/).first();
  await expect(lede).toBeVisible();
  await expect(lede).toContainText("1 event on the calendar");
  await page.screenshot({
    path: "/tmp/2503-uat-today.png",
    clip: { x: 0, y: 0, width: 1200, height: 400 }
  });
});
