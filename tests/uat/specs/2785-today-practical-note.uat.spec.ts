import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2785: the morning Today side column shows a practical note naming the next later timed event
// that has a place, and nothing when no calendar event backs it. It never states a leave time.
export const uatLevel = {
  level: "admin+data",
  without: []
} as const;

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

const execFileAsync = promisify(execFile);

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT fixture target");
  return project;
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

async function seedEvents(
  accountId: string,
  rows: Array<{
    title: string;
    startsAt: string;
    endsAt: string;
    externalId: string;
    location: string | null;
  }>
): Promise<void> {
  const script = `import { randomUUID } from "node:crypto"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const c=new CalendarRepository(); for(const row of ${JSON.stringify(rows)}) await c.upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:${JSON.stringify(accountId)},title:row.title,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),location:row.location,externalId:row.externalId});});}finally{await runner.destroy();} console.log("seeded");})();`;
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

test("morning side column shows a practical note only when a later event has a place", async ({
  page
}) => {
  test.setTimeout(300_000);
  await page.clock.setFixedTime(new Date(localIso(SERVER_DAY, "08:00")));
  await signIn(page);
  const accounts = await json(page, "/api/connectors/accounts");
  const account = (accounts.body.accounts as Array<{ id: string; providerId: string }>).find(
    (a) => a.providerId === "google"
  );
  expect(account, "UAT seed must expose a Google account").toBeTruthy();

  const side = page.getByRole("complementary", { name: "Today widgets" });
  await page.goto(`${baseURL()}/today`);
  await expect(side).toBeVisible();
  await expect(page.getByLabel("A little practical context")).toHaveCount(0);

  await seedEvents(account!.id, [
    {
      title: "Project review",
      startsAt: localIso(SERVER_DAY, "10:00"),
      endsAt: localIso(SERVER_DAY, "10:45"),
      externalId: "2785-a",
      location: "Room 4"
    },
    {
      title: "Pick up the repair",
      startsAt: localIso(SERVER_DAY, "16:00"),
      endsAt: localIso(SERVER_DAY, "16:30"),
      externalId: "2785-b",
      location: "Main Street Repairs"
    },
    {
      title: "Call the bank",
      startsAt: localIso(SERVER_DAY, "17:00"),
      endsAt: localIso(SERVER_DAY, "17:15"),
      externalId: "2785-c",
      location: null
    }
  ]);
  await page.reload();
  const note = page.getByLabel("A little practical context");
  await expect(note).toContainText("Pick up the repair at 4:00 pm is at Main Street Repairs.");
  await expect(note).not.toContainText("Leave at");
  await side.screenshot({ path: "test-results/2785-side-column-note.png" });

  // Phone width: the same note is present and inside the viewport.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  const phoneNote = page.getByLabel("A little practical context");
  await expect(phoneNote).toContainText("Pick up the repair at 4:00 pm is at Main Street Repairs.");
  const box = await phoneNote.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
  await phoneNote.screenshot({ path: "test-results/2785-note-phone-375.png" });
});
