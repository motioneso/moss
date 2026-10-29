import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

const SETTINGS_PATH = "/settings?section=alerts";
const SHOT_DIR = process.env.HEARTBEAT_UAT_SHOT_DIR ?? "/tmp";
const SOURCES = ["Calendar", "Tasks", "Memory", "Sports", "News"] as const;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be supplied by the isolated UAT runner`);
  return value;
}

function sql(statement: string): string {
  const project = env("JARVIS_UAT_PROJECT_NAME");
  if (!/^uat-[a-zA-Z0-9_-]+$/.test(project)) throw new Error("Disposable UAT project required");
  return execFileSync(
    "docker",
    buildUatComposeArgs(project, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-tAc",
      statement
    ]),
    { encoding: "utf8", maxBuffer: 64 * 1024 }
  ).trim();
}

async function signIn(page: Page) {
  await page.goto(env("JARVIS_UAT_BASE_URL"));
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(userMenu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    const confirm = page.getByRole("button", { name: "Skip anyway" });
    if (await confirm.isVisible()) await confirm.click();
  }
  await expect(userMenu).toBeVisible();
}

function card(page: Page) {
  return page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "Moss check-ins" }) })
    .filter({ has: page.getByRole("checkbox", { name: "News" }) })
    .last();
}

function master(page: Page) {
  return page.getByRole("checkbox", { name: "Check in automatically" });
}

function toggle(page: Page, box: Locator) {
  return page.locator("label.jds-switch").filter({ has: box }).click();
}

function heartbeatRow(): string {
  return sql(
    `SELECT revision || ',' || enabled || ',' || cadence_minutes FROM app.heartbeat_settings WHERE owner_user_id = '${UAT_ADMIN_ID}'`
  );
}

test.describe.configure({ mode: "serial" });

test("Moss check-ins settings, real UI and real API", async ({ page, context }) => {
  test.setTimeout(600_000);
  await signIn(page);

  // A fresh owner sees On, hourly, every source on, and opening Settings writes nothing.
  await page.goto(SETTINGS_PATH);
  await expect(page.getByRole("heading", { name: "Moss check-ins" })).toBeVisible();
  await expect(master(page)).toBeChecked();
  for (const name of SOURCES) {
    await expect(page.getByRole("checkbox", { name })).toBeChecked();
  }
  await expect(page.getByText("Never checked", { exact: true })).toBeVisible();
  expect(heartbeatRow()).toBe("");

  // Turn off, save, reload: the choice persists and the stored revision moves to 1.
  await toggle(page, master(page));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(master(page)).not.toBeChecked();
  expect(heartbeatRow()).toBe("1,false,60");

  // Two tabs: the stale tab gets a conflict, nothing is overwritten, and it can adopt the saved state.
  const stale = await context.newPage();
  await stale.goto(SETTINGS_PATH);
  await expect(master(stale)).not.toBeChecked();
  await toggle(page, master(page));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect(heartbeatRow()).toBe("2,true,60");
  await toggle(stale, stale.getByRole("checkbox", { name: "Memory" }));
  await stale.getByRole("button", { name: "Save", exact: true }).click();
  await expect(stale.getByText(/changed in another tab or device/)).toBeVisible();
  expect(heartbeatRow()).toBe("2,true,60");
  await stale.getByRole("button", { name: "Use current settings" }).click();
  await expect(master(stale)).toBeChecked();
  await expect(stale.getByRole("checkbox", { name: "Memory" })).toBeChecked();
  await stale.close();

  // A real scheduled job shows under Scheduled jobs and Stop removes it.
  const threadId = randomUUID();
  const sourceId = randomUUID();
  const reservedId = randomUUID();
  const reminderId = randomUUID();
  sql(
    `SET session_replication_role = replica;
     INSERT INTO app.chat_threads (id, owner_user_id, title) VALUES ('${threadId}', '${UAT_ADMIN_ID}', 'Main');
     INSERT INTO app.chat_messages (id, thread_id, owner_user_id, role, status, body, model_metadata, tool_metadata)
       VALUES ('${sourceId}', '${threadId}', '${UAT_ADMIN_ID}', 'user', 'stored', 'remind me to stretch', '{}', '{}'),
              ('${reservedId}', '${threadId}', '${UAT_ADMIN_ID}', 'assistant', 'stored', 'Reminder: stretch', '{}', '{}');
     INSERT INTO app.chat_reminders (id, owner_user_id, thread_id, source_message_id, reserved_message_id, reminder_text, delay_seconds, due_at)
       VALUES ('${reminderId}', '${UAT_ADMIN_ID}', '${threadId}', '${sourceId}', '${reservedId}', 'stretch', 2592000, now() + interval '30 days');`
  );
  await page.reload();
  const jobs = page.locator("body");
  await expect(jobs.getByRole("button", { name: "Stop" })).toHaveCount(1);
  await jobs.getByRole("button", { name: "Stop" }).click();
  await expect(jobs.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(jobs.getByText("No scheduled jobs.")).toBeVisible();

  // Cropped picture of the Alerts card for the pull request.
  await page.reload();
  await expect(master(page)).toBeChecked();
  await card(page).screenshot({ path: `${SHOT_DIR}/heartbeat-alerts-card.png` });

  // The sweep enrolls the owner and the status panel moves from Never checked to Quiet.
  await expect
    .poll(
      () =>
        sql(
          `SELECT outcome FROM app.heartbeat_occurrences WHERE owner_user_id = '${UAT_ADMIN_ID}' ORDER BY started_at DESC LIMIT 1`
        ),
      { timeout: 420_000, intervals: [10_000] }
    )
    .toBe("quiet");
  await page.reload();
  await expect(page.getByText("Quiet", { exact: true })).toBeVisible();
  await card(page).screenshot({ path: `${SHOT_DIR}/heartbeat-alerts-card-after.png` });
});
