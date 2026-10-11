import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Park Press check 4 (PR 3348): notification mark-read progress and failure show on the specific
// item. The failure is real: the app container is stopped before the click.
export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT target");
  return project;
}

async function composeApp(action: "stop" | "start"): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(uatProject(), [action, "postgres"]), {
    maxBuffer: 1_000_000
  });
}

async function createNotifications(titles: string[]): Promise<void> {
  const script = `import { NotificationsRepository } from "/app/packages/notifications/src/repository.ts"; import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts"; const runner=createAppRuntimeRunner(); (async()=>{try{await runner.withDataContext({actorUserId:${JSON.stringify(UAT_ADMIN_ID)}},async(db)=>{const repo=new NotificationsRepository(); for (const title of ${JSON.stringify(titles)}) { await repo.create(db,{moduleId:"tasks",title,body:"Park Press check 4"}); }});}finally{await runner.destroy();} console.log("created ${titles.length}");})();`;
  const { stdout } = await execFileAsync(
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
  console.log(`[check4] notifications: ${stdout.trim()}`);
}

async function waitHealthy(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get(`${baseURL()}/health/ready`, { timeout: 3000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 120_000, intervals: [1000] }
    )
    .toBe(200);
}

test("Notifications: failed mark-read shows on the item only, then recovers (LN13)", async ({
  page
}) => {
  test.setTimeout(300_000);
  await createNotifications(["PP4 alpha item", "PP4 bravo item"]);
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

  await page.goto(`${baseURL()}/notifications`);
  const alpha = page.locator("article", { hasText: "PP4 alpha item" });
  const bravo = page.locator("article", { hasText: "PP4 bravo item" });
  await expect(alpha).toBeVisible({ timeout: 30_000 });
  await expect(bravo).toBeVisible();

  await composeApp("stop");
  try {
    await alpha.getByRole("button", { name: /^Mark .* read$/ }).click();
    await expect(alpha.getByRole("alert")).toContainText(
      "Could not mark this notification read. Try again.",
      { timeout: 60_000 }
    );
    // The failure belongs to the clicked item, not to the page or the other item.
    await expect(bravo.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Could not mark notifications read. Try again.")).toHaveCount(0);
    await expect(alpha).not.toHaveAttribute("aria-busy", "true");
  } finally {
    await composeApp("start");
  }
  await waitHealthy(page);

  await alpha.getByRole("button", { name: /^Mark .* read$/ }).click();
  await expect(alpha.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("tab", { name: /unread/i })
    .or(page.getByText("Unread"))
    .first()
    .click();
  await expect(page.locator("article", { hasText: "PP4 alpha item" })).toHaveCount(0);
  await expect(page.locator("article", { hasText: "PP4 bravo item" })).toBeVisible();
});
