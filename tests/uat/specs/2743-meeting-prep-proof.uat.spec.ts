import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Live proof for #2743: the Today first-meeting card's preparation line, and its link
// to the real meeting. Temporary — removed before this branch is pushed; lasting
// coverage lives in tests/unit/today-rail-preparation.test.tsx.
export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);

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

// Fixed offsets from the moment the test runs, not a wall-clock hour — the
// disposable stack's "now" does not line up with a chosen clock time, and the
// first-meeting card only renders for an event still ahead of it today.
function fromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
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
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
}

// Creates a fresh fake connector account plus one cached calendar event, run inside the
// stack's own container so it uses the real repositories, not a second database
// connection from the test runner. `jarvisCreated` decides whether the row is a real
// Moss block (matches the same signal apps/web reads through CalendarEventDto.isMossBlock).
async function seedEvent(input: {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  jarvisCreated?: boolean;
}): Promise<string> {
  const script = `import { randomUUID } from "node:crypto"; import { ConnectorsRepository } from "/app/packages/connectors/src/repository.ts"; import { createConnectorSecretCipher } from "/app/packages/connectors/src/crypto.ts"; import { CalendarRepository } from "/app/packages/calendar/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const connectors=new ConnectorsRepository(); const cipher=createConnectorSecretCipher(); const account=await connectors.createAccount(db,{providerId:"google",scopes:["https://www.googleapis.com/auth/calendar"],encryptedSecret:cipher.encryptJson({cli:true})}); await new CalendarRepository().upsertCachedEvent(db,{id:randomUUID(),connectorAccountId:account.id,title:${JSON.stringify(input.title)},startsAt:new Date(${JSON.stringify(input.startsAt)}),endsAt:new Date(${JSON.stringify(input.endsAt)}),externalId:${JSON.stringify(input.externalId)},externalMetadata:${JSON.stringify(input.jarvisCreated ? { jarvisCreated: true } : {})}});console.log(JSON.stringify({accountId:account.id}));});}finally{await runner.destroy();}})();`;
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
  console.log(`[2743 seed fixture] ${r.stdout.trim()}`);
  return input.externalId;
}

test("first-meeting card shows the preparation line only for a really-titled block, and links to the real meeting", async ({
  page
}) => {
  await signIn(page);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);

  const meetingStart = fromNow(90);
  const meetingEnd = fromNow(120);

  await seedEvent({
    externalId: `2743-meeting-${randomUUID()}`,
    title: "10am team sync",
    startsAt: meetingStart,
    endsAt: meetingEnd
  });

  // (b) no preceding block at all -> no preparation line.
  await page.goto(baseURL());
  await expect(page.locator(".cmd-next__what")).toHaveText("10am team sync");
  await expect(page.locator(".cmd-next__note")).toHaveCount(1);
  await expect(page.locator(".cmd-next__note").first()).toContainText("30 minutes");

  // A touching Moss block with an unrelated title -> still no line.
  await seedEvent({
    externalId: `2743-focus-${randomUUID()}`,
    title: "Deep work on the roadmap doc",
    startsAt: fromNow(60),
    endsAt: meetingStart,
    jarvisCreated: true
  });
  await page.reload();
  await expect(page.locator(".cmd-next__note")).toHaveCount(1);

  // (a) a touching Moss block titled as preparation -> the line appears.
  await seedEvent({
    externalId: `2743-prep-${randomUUID()}`,
    title: "Prep for the 10am",
    startsAt: fromNow(60),
    endsAt: meetingStart,
    jarvisCreated: true
  });
  await page.reload();
  await expect(page.locator(".cmd-next__note")).toHaveCount(2);
  await expect(page.locator(".cmd-next__note").nth(1)).toContainText(
    "You have a 30-minute preparation block before this meeting."
  );

  // (c) the link opens that exact meeting on the calendar screen.
  await page.getByRole("button", { name: "See meeting ↗" }).click();
  await expect(page).toHaveURL(/\/calendar\?event=/);
  await expect(page.getByRole("heading", { name: "10am team sync" })).toBeVisible();
});
